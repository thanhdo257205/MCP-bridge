import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable, startProcess, terminateOwned } from '../src/antigravity/process.js';
import { loadConfig } from '../src/config.js';

// Captures what `agy --output-format stream-json` really emits so progress reporting can be built on the real format.
// It makes one tiny real AI call (cached login, no tools, scratch directory) and only writes under test-results/.
const config = await loadConfig();
const executable = await findExecutable(config.executable);
const workspace = await mkdtemp(path.join(tmpdir(), 'agy-stream-probe-'));
const child = startProcess(executable, ['--print', 'Reply with exactly STREAM_PROBE_OK. Do not use any tools, read files, change files or run commands.',
  '--output-format', 'stream-json', '--print-timeout', '90s', '--disable-slash-commands'], workspace);
let stdout = '';
let stderr = '';
child.stdout!.on('data', (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < 100_000) stderr += chunk.toString(); });
const timer = setTimeout(() => void terminateOwned(child), 120_000);
const code = await new Promise<number | null>(resolve => child.once('close', resolve));
clearTimeout(timer);

const lines = stdout.split('\n').filter(line => line.trim());
const events = lines.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } });
const kinds = new Map<string, {count: number; keys: Set<string>}>();
for (const event of events) {
  const kind = event ? String(event.event ?? event.type ?? '(no event/type key)') : '(not JSON)';
  const entry = kinds.get(kind) ?? {count: 0, keys: new Set<string>()};
  entry.count++;
  for (const key of Object.keys(event ?? {})) entry.keys.add(key);
  kinds.set(kind, entry);
}
const results = path.join(fileURLToPath(new URL('../../test-results/', import.meta.url)));
await mkdir(results, {recursive: true});
await writeFile(path.join(results, 'stream-probe.ndjson'), stdout);
await writeFile(path.join(results, 'stream-probe.stderr.txt'), stderr);
console.log(`agy exit code: ${code}; ${lines.length} stdout line(s); raw output saved to test-results/stream-probe.ndjson (gitignored)`);
for (const [kind, {count, keys}] of kinds) console.log(`- ${kind} x${count}: keys = ${[...keys].join(', ')}`);
console.log(events.every(Boolean) ? 'Every stdout line is a JSON object.' : 'Some stdout lines are not JSON; see the raw file.');
console.log('Share the event names and keys above (not the raw file, which may contain paths) to build progress reporting on the real format.');
