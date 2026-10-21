import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateRelease } from './release-check.js';

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function assertSha(sha: string): void {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full Git commit SHA.');
}

export function nextPatch(version: string): string {
  const match = stable.exec(version);
  if (!match) throw new Error('Automatic releases require a stable X.Y.Z version.');
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`;
}

export function releasePlan(source: string, head: string, parent: string, message: string): 'bump' | 'resume' | 'stale' {
  assertSha(source); assertSha(head);
  if (head === source) return 'bump';
  if (parent === source && message.split(/\r?\n/).includes(`Release-Source: ${source}`) &&
      /^chore\(release\): \d+\.\d+\.\d+ \[skip ci\]$/.test(message.split(/\r?\n/)[0])) return 'resume';
  return 'stale';
}

/** Only version fields may change after CI has approved the source commit. */
export function validateVersionChange(before: Record<string, any>, after: Record<string, any>, lock = false): void {
  const expected = structuredClone(before);
  expected.version = nextPatch(before.version);
  if (lock) expected.packages[''].version = expected.version;
  if (JSON.stringify(expected) !== JSON.stringify(after)) throw new Error('Release may only change the patch version in the manifests.');
}

export async function versionPublished(version: string, request: typeof fetch = fetch): Promise<boolean> {
  if (!stable.test(version)) throw new Error('Expected a stable release version.');
  const response = await request(`https://registry.npmjs.org/agy-mcp-bridge/${version}`, {signal: AbortSignal.timeout(10_000)});
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Registry check failed: HTTP ${response.status}; refusing to assume unpublished.`);
  const data = await response.json() as {name?: string; version?: string};
  if (data.name !== 'agy-mcp-bridge' || data.version !== version) throw new Error('Registry returned unexpected package metadata.');
  return true;
}

export function prepareRelease(cwd: string, source: string): 'bump' | 'resume' | 'stale' {
  assertSha(source);
  git(cwd, 'fetch', 'origin', 'main', '--tags');
  const head = git(cwd, 'rev-parse', 'origin/main');
  const parent = git(cwd, 'rev-parse', `${head}^`);
  const plan = releasePlan(source, head, parent, git(cwd, 'show', '-s', '--format=%B', head));
  if (plan !== 'stale') git(cwd, 'checkout', '-B', 'release-work', head);
  return plan;
}

export function finalizeRelease(cwd: string, source: string): string {
  assertSha(source);
  const manifest = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8'));
  const lock = JSON.parse(readFileSync(`${cwd}/package-lock.json`, 'utf8'));
  const before = JSON.parse(git(cwd, 'show', `${source}:package.json`));
  const beforeLock = JSON.parse(git(cwd, 'show', `${source}:package-lock.json`));
  validateVersionChange(before, manifest);
  validateVersionChange(beforeLock, lock, true);
  const version = validateRelease(`refs/tags/v${manifest.version}`, manifest, lock);
  const head = git(cwd, 'rev-parse', 'HEAD');
  const changed = git(cwd, 'diff', '--name-only', source).split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify(['package-lock.json', 'package.json'])) throw new Error('Untested code changes found after CI.');
  if (head === source) {
    git(cwd, 'add', '--', 'package.json', 'package-lock.json');
    git(cwd, 'commit', '-m', `chore(release): ${version} [skip ci]`, '-m', `Release-Source: ${source}`);
    git(cwd, 'tag', '-a', `v${version}`, '-m', `Release v${version}`);
  } else {
    const parent = git(cwd, 'rev-parse', 'HEAD^');
    if (releasePlan(source, head, parent, git(cwd, 'show', '-s', '--format=%B')) !== 'resume' ||
        git(cwd, 'rev-parse', `v${version}^{commit}`) !== head || git(cwd, 'status', '--porcelain')) {
      throw new Error('Existing release commit or tag does not match this CI run.');
    }
  }
  // No force push: a concurrent developer push rejects the entire transaction,
  // including the tag. Nothing is published unless this succeeds.
  git(cwd, 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/v${version}`);
  return version;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}
function output(values: Record<string, string>): void {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.env.GITHUB_SHA ?? '';
  const cwd = process.cwd();
  switch (process.argv[2]) {
    case 'prepare': {
      const plan = prepareRelease(cwd, source);
      console.log(`Release plan: ${plan}${plan === 'stale' ? ' (main has newer work; its CI run will release it)' : ''}`);
      output({ready: String(plan !== 'stale'), bump: String(plan === 'bump')});
      break;
    }
    case 'finalize': {
      const version = finalizeRelease(cwd, source);
      output({version, release_ref: `refs/tags/v${version}`});
      break;
    }
    case 'registry': output({publish_needed: String(!await versionPublished(process.env.RELEASE_VERSION ?? ''))}); break;
    default: throw new Error('Usage: auto-release.js prepare|finalize|registry');
  }
}
