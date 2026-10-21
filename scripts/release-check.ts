import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

interface Manifest { name?: string; version?: string; private?: boolean; license?: string; publishConfig?: {access?: string}; }
interface Lock { name?: string; version?: string; packages?: Record<string, {name?: string; version?: string}>; }

/** Stable releases only: prereleases must never replace the npm latest tag. */
export function validateRelease(ref: string | undefined, manifest: Manifest, lock: Lock): string {
  if (!ref || !/^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref)) {
    throw new Error('Release requires a stable tag refs/tags/vX.Y.Z (no prerelease or build suffix).');
  }
  const version = ref.slice('refs/tags/v'.length);
  if (manifest.name !== 'agy-mcp-bridge' || manifest.private || manifest.license !== 'MIT' || manifest.publishConfig?.access !== 'public') {
    throw new Error('Release requires the public MIT package agy-mcp-bridge.');
  }
  if (manifest.version !== version || lock.version !== version || lock.packages?.['']?.version !== version ||
      lock.name !== manifest.name || lock.packages?.['']?.name !== manifest.name) {
    throw new Error(`Release tag ${version} must match package.json and both package-lock.json versions/names. Run npm version before pushing the tag.`);
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL('../../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as Manifest;
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8')) as Lock;
  console.log(`Release validated: agy-mcp-bridge@${validateRelease(process.env.GITHUB_REF, manifest, lock)}`);
}
