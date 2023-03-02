import { execSync } from 'child_process';
import * as rl from 'readline';
import { stdin, stdout } from 'process';
import yargs from 'yargs';

export function extractUpstreamNameFromRemotes(remoteGitVerbose: string, upstreamRepositoryName: string): string | undefined {
  const lineWithRepoName = remoteGitVerbose.split('\n').find((l) => l.indexOf(upstreamRepositoryName) > -1);
  return lineWithRepoName?.split(/\s/)?.[0];
}

export interface MergeOptions {
  message: string;
  mode: 'ff-only';
}
export class Git {
  remote(verbose?: boolean): string {
    let command = ['git', 'remote'];
    if (verbose) {
      command.push('-v');
    }
    return execSync(command.join(' ')).toString();
  }

  isExistingBranch(branch: string): boolean {
    const command = ['git', 'rev-parse', '--verify', branch];
    try {
      execSync(command.join(' '));
      return true;
    } catch (e) {
      return false;
    }
  }

  getShortSha(ref: string = 'HEAD'): string {
    const command = ['git', 'rev-parse', '--short', ref];
    return execSync(command.join(' ')).toString().trim();
  }

  deleteBranch(branch: string) {
    let command = ['git', 'branch', '-D', branch];
    execSync(command.join(' '));
  }

  pull(remote?: string, branch?: string) {
    let command = ['git', 'pull'];
    if (remote) {
      command.push(remote);
      if (branch) {
        command.push(branch);
      }
    }
    execSync(command.join(' '));
  }

  checkout(branch: string, create: boolean = false): void {
    const command = ['git', 'checkout'];
    if (create) {
      command.push('-b');
    }
    command.push(branch);
    execSync(command.join(' '));
  }

  merge(branch: string, options: Partial<MergeOptions> = {}): void {
    const command = ['git', 'merge', branch];
    if (options.message) {
      command.push('-m');
      command.push(`"${options.message}"`);
    }
    if (options.mode) {
      command.push(`--${options.mode}`);
    }
    execSync(command.join(' '));
  }

  push(remote: string, branch: string) {
    const command = ['git', 'push', remote, branch];
    execSync(command.join(' '));
  }

  fetch(remote: string, branch?: string) {
    const command = ['git', 'fetch', remote];
    if (branch) {
      command.push(branch);
    }
    execSync(`git fetch ${remote} ${branch}`);
  }

  isCleanWorkingTree(): boolean {
    const buffer = execSync('git status --porcelain');
    return !buffer.toString().trim();
  }
}

export async function shouldContinue(read: rl.Interface, prompt: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    read.question(`${prompt}\nContinue? (y/n) `, (answer) => {
      if (answer.toLowerCase().trim() === 'y') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

export function getCompareLink(devBranch: string, mergeBranch: string): string {
  return `https://github.com/aws-amplify/amplify-cli/compare/${devBranch}...${mergeBranch}`;
}

export function prepareBranches(upstreamName: string, devBranch: string, mergeBranch: string, releaseBranch: string, git: Git) {
  git.checkout(devBranch);
  git.pull(upstreamName, devBranch);
  git.checkout(mergeBranch, true);
  git.fetch(upstreamName, releaseBranch);
  git.merge(`${upstreamName}/${releaseBranch}`, { message: 'chore: merge release commit from main to dev' });
}
type Args = {
  continue: boolean;
  releaseBranch: string;
  mergeBranch?: string;
  devBranch: string;
  repository: string;
};
function getArgs(): Args {
  const args = yargs(process.argv.slice(2))
    .string('release-branch')
    .default('release-branch', 'main')
    .string('dev-branch')
    .default('dev-branch', 'dev')
    .string('repository')
    .default('repository', 'aws-amplify/amplify-cli')
    .boolean('continue')
    .default('continue', false)
    .string('merge-branch').argv;
  return {
    continue: args.continue,
    releaseBranch: args['release-branch'],
    devBranch: args['dev-branch'],
    mergeBranch: args['merge-branch'],
    repository: args.repository,
  };
}

export async function main() {
  const {
    continue: continueArg,
    releaseBranch: RELEASE_BRANCH,
    devBranch: DEV_BRANCH,
    repository: REPO_NAME,
    mergeBranch: mergeBranchArg,
  } = getArgs();
  const git = new Git();
  const rlInterface = rl.createInterface({
    input: stdin,
    output: stdout,
  });

  if (!git.isCleanWorkingTree()) {
    console.error('Please run the script from a clean working tree');
    process.exit(2);
  }

  const remoteOutput = git.remote(true);
  const upstreamName = extractUpstreamNameFromRemotes(remoteOutput, REPO_NAME);
  if (!upstreamName) {
    console.error('could not find remote name for the aws-amplify/amplify-cli repository');
    process.exit(1);
  }

  console.info(`Fetching ${upstreamName}/${RELEASE_BRANCH}`);
  git.fetch(upstreamName, RELEASE_BRANCH);

  const releaseSha = git.getShortSha(`${upstreamName}/${RELEASE_BRANCH}`);
  const mergeBranch = mergeBranchArg ?? 'dev-main-merge-' + releaseSha;
  const doesMergeBranchExist = git.isExistingBranch(mergeBranch);

  if (!continueArg && doesMergeBranchExist) {
    console.error(
      `The merge branch \`${mergeBranch}\` already exists. Please delete the merge branch and try again, or run the script with \`--continue\``,
    );
    process.exit(1);
  }
  const canContinue = continueArg || (await shouldContinue(rlInterface, `This will create the merge branch \`${mergeBranch}\`.`));
  if (!canContinue) {
    console.info('Exiting...');
    process.exit(0);
  }

  console.info('Switching to branch ' + DEV_BRANCH);
  git.checkout(DEV_BRANCH);
  git.pull();
  console.info('Creating merge branch ' + mergeBranch);
  try {
    const shouldAttemptCreate = !doesMergeBranchExist;
    git.checkout(mergeBranch, shouldAttemptCreate);
  } catch (e) {
    console.error('Failed to create merge branch, exiting...');
    process.exit(1);
  }

  console.info(`Merging ${upstreamName}/${RELEASE_BRANCH} into ${mergeBranch}`);
  git.merge(`${upstreamName}/${RELEASE_BRANCH}`, { message: 'chore: merge release commit from main to dev' });

  if (!git.isCleanWorkingTree()) {
    console.info('Resolve merge conflicts and commit merge, then run `yarn run finish-release --continue`');
    process.exit(0);
  }

  git.push(upstreamName, mergeBranch);

  console.info(`
You can compare changes between the branches here: ${getCompareLink(
    DEV_BRANCH,
    mergeBranch,
  )}. To finish the release, open a pull request between ${mergeBranch} into ${DEV_BRANCH}
`);

  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(1));
}
