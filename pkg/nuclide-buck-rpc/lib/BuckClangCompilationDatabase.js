/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {CompilationDatabaseParams} from '../../nuclide-buck/lib/types';
import type {BuckClangCompilationDatabase} from './types';

import {SimpleCache} from 'nuclide-commons/SimpleCache';
import * as ClangService from '../../nuclide-clang-rpc';
import * as BuckService from './BuckServiceImpl';
import {getLogger} from 'log4js';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {guessBuildFile, isHeaderFile} from '../../nuclide-clang-rpc/lib/utils';

const logger = getLogger('nuclide-buck');
const BUCK_TIMEOUT = 10 * 60 * 1000;
const TARGET_KIND_REGEX = [
  'apple_binary',
  'apple_library',
  'apple_test',
  'cxx_binary',
  'cxx_library',
  'cxx_test',
].join('|');

/**
 * Facebook puts all headers in a <target>:__default_headers__ build target by default.
 * This target will never produce compilation flags, so make sure to ignore it.
 */
const DEFAULT_HEADERS_TARGET = '__default_headers__';

class BuckClangCompilationDatabaseHandler {
  _targetCache = new SimpleCache({keyFactory: JSON.stringify});
  _sourceCache = new SimpleCache();
  // Ensure that we can clear targetCache for a given file.
  _sourceToTargetKey = new Map();
  _params: CompilationDatabaseParams;

  constructor(params: CompilationDatabaseParams) {
    this._params = params;
  }

  resetForSource(src: string): void {
    this._sourceCache.delete(src);
    const targetKey = this._sourceToTargetKey.get(src);
    if (targetKey != null) {
      this._targetCache.delete(targetKey);
      this._sourceToTargetKey.delete(src);
    }
  }

  reset(): void {
    this._sourceCache.clear();
    this._targetCache.clear();
    this._sourceToTargetKey.clear();
  }

  getCompilationDatabase(file: string): Promise<?BuckClangCompilationDatabase> {
    return this._sourceCache.getOrCreate(file, async () => {
      if (isHeaderFile(file)) {
        const source = await ClangService.getRelatedSourceOrHeader(file);
        if (source != null) {
          logger.info(
            `${file} is a header, thus using ${source} for getting the compilation flags.`,
          );
          return this.getCompilationDatabase(source);
        } else {
          logger.error(
            `Couldn't find a corresponding source file for ${file}, thus there are no compilation flags available.`,
          );
          return {
            file: null,
            flagsFile: await guessBuildFile(file),
            libclangPath: null,
            warnings: [
              `I could not find a corresponding source file for ${file}.`,
            ],
          };
        }
      } else {
        return this._getCompilationDatabase(file);
      }
    });
  }

  async _getCompilationDatabase(
    file: string,
  ): Promise<?BuckClangCompilationDatabase> {
    const buckRoot = await BuckService.getRootForPath(file);
    return this._loadCompilationDatabaseFromBuck(file, buckRoot)
      .catch(err => {
        logger.error('Error getting flags from Buck for file ', file, err);
        throw err;
      })
      .then(db => {
        if (db != null) {
          this._cacheFilesToCompilationDB(db);
        }
        return db;
      });
  }

  async _loadCompilationDatabaseFromBuck(
    src: string,
    buckRoot: ?string,
  ): Promise<?BuckClangCompilationDatabase> {
    if (buckRoot == null) {
      return null;
    }

    let queryTarget = null;
    const extraArgs =
      this._params.args.length === 0
        ? await BuckService._getPreferredArgsForRepo(buckRoot)
        : this._params.args;
    try {
      const owners = (await BuckService.getOwners(
        buckRoot,
        src,
        extraArgs,
        TARGET_KIND_REGEX,
        false,
      )).filter(x => x.indexOf(DEFAULT_HEADERS_TARGET) === -1);
      // Deprioritize Android-related targets because they build with gcc and
      // require gcc intrinsics that cause libclang to throw bad diagnostics.
      owners.sort((a, b) => {
        const aAndroid = a.endsWith('Android');
        const bAndroid = b.endsWith('Android');
        if (aAndroid && !bAndroid) {
          return 1;
        } else if (!aAndroid && bAndroid) {
          return -1;
        } else {
          return 0;
        }
      });
      queryTarget = owners[0];
    } catch (err) {
      logger.error('Failed getting the target from buck', err);
    }

    if (queryTarget == null) {
      // Even if we can't get flags, return a flagsFile to watch
      const buildFile = await guessBuildFile(src);
      if (buildFile != null) {
        return {
          flagsFile: buildFile,
          file: null,
          libclangPath: null,
          warnings: [
            `I could not find owner target of ${src}`,
            `Is there an error in ${buildFile}?`,
          ],
        };
      }
      return null;
    }
    const target = queryTarget;

    this._sourceToTargetKey.set(
      src,
      this._targetCache.keyForArgs([buckRoot, target, extraArgs]),
    );

    return this._targetCache.getOrCreate([buckRoot, target, extraArgs], () =>
      this._loadCompilationDatabaseForBuckTarget(buckRoot, target, extraArgs),
    );
  }

  async _loadCompilationDatabaseForBuckTarget(
    buckProjectRoot: string,
    target: string,
    extraArgs: Array<string>,
  ): Promise<BuckClangCompilationDatabase> {
    const allFlavors = [
      'compilation-database',
      ...this._params.flavorsForTarget,
    ];
    if (this._params.useDefaultPlatform) {
      const platform = await BuckService.getDefaultPlatform(
        buckProjectRoot,
        target,
        extraArgs,
        false,
      );
      if (platform != null) {
        allFlavors.push(platform);
      }
    }
    const buildTarget = target + '#' + allFlavors.join(',');
    const buildReport = await BuckService.build(
      buckProjectRoot,
      [
        // Small builds, like those used for a compilation database, can degrade overall
        // `buck build` performance by unnecessarily invalidating the Action Graph cache.
        // See https://buckbuild.com/concept/buckconfig.html#client.skip-action-graph-cache
        // for details on the importance of using skip-action-graph-cache=true.
        '--config',
        'client.skip-action-graph-cache=true',

        buildTarget,
        ...extraArgs,
        // TODO(hansonw): Any alternative to doing this?
        // '-L',
        // String(os.cpus().length / 2),
      ],
      {commandOptions: {timeout: BUCK_TIMEOUT}},
    );
    if (!buildReport.success) {
      const error = new Error(`Failed to build ${buildTarget}`);
      logger.error(error);
      throw error;
    }
    const firstResult = Object.keys(buildReport.results)[0];
    let pathToCompilationDatabase = buildReport.results[firstResult].output;
    pathToCompilationDatabase = nuclideUri.join(
      buckProjectRoot,
      pathToCompilationDatabase,
    );

    const buildFile = await BuckService.getBuildFile(
      buckProjectRoot,
      target,
      extraArgs,
    );
    const compilationDB = {
      file: pathToCompilationDatabase,
      flagsFile: buildFile,
      libclangPath: null,
      target,
      warnings: [],
    };
    return this._processCompilationDb(
      compilationDB,
      buckProjectRoot,
      extraArgs,
    );
  }

  async _processCompilationDb(
    db: BuckClangCompilationDatabase,
    buckRoot: string,
    args: string[],
  ): Promise<BuckClangCompilationDatabase> {
    try {
      // $FlowFB
      const {createOmCompilationDb} = require('./fb/omCompilationDb');
      return await createOmCompilationDb(db, buckRoot, args);
    } catch (e) {}
    return db;
  }

  async _cacheFilesToCompilationDB(
    db: BuckClangCompilationDatabase,
  ): Promise<void> {
    const {file} = db;
    if (file == null) {
      return;
    }
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line nuclide-internal/unused-subscription
      ClangService.loadFilesFromCompilationDatabaseAndCacheThem(
        file,
        db.flagsFile,
      )
        .refCount()
        .subscribe(
          path => this._sourceCache.set(path, Promise.resolve(db)),
          reject, // on error
          resolve, // on complete
        );
    });
  }
}

const compilationDatabaseHandlerCache = new SimpleCache({
  keyFactory: (params: CompilationDatabaseParams) => JSON.stringify(params),
});

export function getCompilationDatabaseHandler(
  params: CompilationDatabaseParams,
): BuckClangCompilationDatabaseHandler {
  return compilationDatabaseHandlerCache.getOrCreate(
    params,
    () => new BuckClangCompilationDatabaseHandler(params),
  );
}
