import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Node 20 on Windows does not expand globs in `node --test`, and a directory argument would also run fixtures. List the files explicitly.
const directory = fileURLToPath(new URL('../tests/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(directory, name));
if (!files.length) { console.error('No compiled tests found; run npm run build first.'); process.exit(1); }
// Most of these tests start a real server on a loopback port and time its output, so a runner under load makes them
// fail on timing rather than on behaviour; the suite is sequential on purpose and a parallel failure is not evidence.
process.exit(spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {stdio: 'inherit'}).status ?? 1);
