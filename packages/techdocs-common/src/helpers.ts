/*
 * Copyright 2020 Spotify AB
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import os from 'os';
import path from 'path';
import parseGitUrl from 'git-url-parse';
import fs from 'fs-extra';
import { getDefaultBranch } from './default-branch';
import { getGitRepoType, getTokenForGitRepo } from './git-auth';
import { Entity } from '@backstage/catalog-model';
import { InputError, UrlReader, Git } from '@backstage/backend-common';
import { RemoteProtocol } from './stages/prepare/types';
import { Logger } from 'winston';

export type ParsedLocationAnnotation = {
  type: RemoteProtocol;
  target: string;
};

export const parseReferenceAnnotation = (
  annotationName: string,
  entity: Entity,
): ParsedLocationAnnotation => {
  const annotation = entity.metadata.annotations?.[annotationName];

  if (!annotation) {
    throw new InputError(
      `No location annotation provided in entity: ${entity.metadata.name}`,
    );
  }

  // split on the first colon for the protocol and the rest after the first split
  // is the location.
  const [type, target] = annotation.split(/:(.+)/) as [
    RemoteProtocol?,
    string?,
  ];

  if (!type || !target) {
    throw new InputError(
      `Failure to parse either protocol or location for entity: ${entity.metadata.name}`,
    );
  }

  return {
    type,
    target,
  };
};

export const getLocationForEntity = (
  entity: Entity,
): ParsedLocationAnnotation => {
  const { type, target } = parseReferenceAnnotation(
    'backstage.io/techdocs-ref',
    entity,
  );

  switch (type) {
    case 'github':
    case 'gitlab':
    case 'azure/api':
    case 'url':
      return { type, target };
    case 'dir':
      if (path.isAbsolute(target)) return { type, target };

      return parseReferenceAnnotation(
        'backstage.io/managed-by-location',
        entity,
      );
    default:
      throw new Error(`Invalid reference annotation ${type}`);
  }
};

export const getGitRepositoryTempFolder = async (
  repositoryUrl: string,
): Promise<string> => {
  const parsedGitLocation = parseGitUrl(repositoryUrl);
  // removes .git from git location path
  parsedGitLocation.git_suffix = false;

  if (!parsedGitLocation.ref) {
    parsedGitLocation.ref = await getDefaultBranch(
      parsedGitLocation.toString('https'),
    );
  }

  return path.join(
    // fs.realpathSync fixes a problem with macOS returning a path that is a symlink
    fs.realpathSync(os.tmpdir()),
    'backstage-repo',
    parsedGitLocation.source,
    parsedGitLocation.owner,
    parsedGitLocation.name,
    parsedGitLocation.ref,
  );
};

export const checkoutGitRepository = async (
  repoUrl: string,
  logger: Logger,
): Promise<string> => {
  const parsedGitLocation = parseGitUrl(repoUrl);
  const repositoryTmpPath = await getGitRepositoryTempFolder(repoUrl);
  const token = await getTokenForGitRepo(repoUrl);

  // Initialize a git client
  let git = Git.fromAuth({ logger });

  // Docs about why username and password are set to these specific values.
  // https://isomorphic-git.org/docs/en/onAuth#oauth2-tokens
  if (token) {
    const type = getGitRepoType(repoUrl);
    switch (type) {
      case 'github':
        git = Git.fromAuth({
          username: token,
          password: 'x-oauth-basic',
          logger,
        });
        parsedGitLocation.token = `${token}:x-oauth-basic`;
        break;
      case 'gitlab':
        git = Git.fromAuth({
          username: 'oauth2',
          password: token,
          logger,
        });
        parsedGitLocation.token = `dummyUsername:${token}`;
        parsedGitLocation.git_suffix = true;
        break;
      case 'azure/api':
        git = Git.fromAuth({
          username: 'notempty',
          password: token,
          logger: logger,
        });
        break;
      default:
        parsedGitLocation.token = `:${token}`;
    }
  }

  // Pull from repository if it has already been cloned.
  if (fs.existsSync(repositoryTmpPath)) {
    try {
      const currentBranchName = await git.currentBranch({
        dir: repositoryTmpPath,
      });

      await git.fetch({ dir: repositoryTmpPath, remote: 'origin' });
      await git.merge({
        dir: repositoryTmpPath,
        headBranch: `origin/${currentBranchName}`,
        baseBranch: currentBranchName || undefined,
      });
      return repositoryTmpPath;
    } catch (e) {
      logger.info(
        `Found error "${e.message}" in cached repository "${repoUrl}" when getting latest changes. Removing cached repository.`,
      );
      fs.removeSync(repositoryTmpPath);
    }
  }

  const repositoryCheckoutUrl = parsedGitLocation.toString('https');

  fs.mkdirSync(repositoryTmpPath, { recursive: true });
  await git.clone({ url: repositoryCheckoutUrl, dir: repositoryTmpPath });

  return repositoryTmpPath;
};

export const getLastCommitTimestamp = async (
  repositoryUrl: string,
  logger: Logger,
): Promise<number> => {
  const repositoryLocation = await checkoutGitRepository(repositoryUrl, logger);

  const git = Git.fromAuth({ logger });
  const sha = await git.resolveRef({ dir: repositoryLocation, ref: 'HEAD' });
  const commit = await git.readCommit({ dir: repositoryLocation, sha });

  return commit.commit.committer.timestamp;
};

export const getDocFilesFromRepository = async (
  reader: UrlReader,
  entity: Entity,
): Promise<any> => {
  const { target } = parseReferenceAnnotation(
    'backstage.io/techdocs-ref',
    entity,
  );

  const response = await reader.readTree(target);

  return await response.dir();
};
