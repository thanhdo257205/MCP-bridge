import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Node 20 on Windows does not expand globs in `node --test`, and a directory argument would also run fixtures. List the files explicitly.
const directory = fileURLToPath(new URL('../tests/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(directory, name));
if (!files.length) { console.error('No compiled tests found; run npm run build first.'); process.exit(1); }
process.exit(spawnSync(process.execPath, ['--test', ...files], {stdio: 'inherit'}).status ?? 1);
