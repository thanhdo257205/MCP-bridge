import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startProcess, terminateOwned } from './antigravity/process.js';

export interface ModelInfo { id: string; label: string; }
export const MODEL_FILE = 'model.json';
// Ids go straight into the agy command line, so only plain identifier characters are ever accepted (and never a leading dash).
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const validModelId = (value: unknown): value is string => typeof value === 'string' && MODEL_ID.test(value);

/** Parses `agy models`: one model per line, the id first, then the display name after two or more spaces. */
export function parseModels(text: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s{2,}(.+?)\s*$/);
    if (match && validModelId(match[1]) && !models.some(model => model.id === match[1])) models.push({id: match[1], label: match[2].slice(0, 100)});
  }
  return models;
}

/** Runs `agy models`; rejects when the command fails, times out or prints nothing recognizable. */
export function listModels(executable: string, cwd: string, extraEnvPassthrough: string[] = []): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    const child = startProcess(executable, ['models'], cwd, {extraEnvPassthrough});
    let text = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void terminateOwned(child).catch(() => {}); }, 10000);
    const collect = (chunk: Buffer) => { if (text.length < 32768) text += chunk.toString().slice(0, 32768 - text.length); };
    child.stdout!.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      const models = parseModels(text);
      if (timedOut) reject(new Error('`agy models` timed out'));
      else if (code !== 0 || !models.length) reject(new Error('`agy models` did not return a model list'));
      else resolve(models);
    });
  });
}

/** The model chosen in the web UI, or null to leave the choice to Antigravity. Read on every task, so a change needs no restart. */
export async function readModel(stateDirectory: string): Promise<string | null> {
  try {
    const value = (JSON.parse(await readFile(path.join(stateDirectory, MODEL_FILE), 'utf8')) as {model?: unknown}).model;
    return validModelId(value) ? value : null;
  } catch { return null; }
}
export async function writeModel(stateDirectory: string, model: string | null): Promise<void> {
  const file = path.join(stateDirectory, MODEL_FILE);
  if (model === null) { await rm(file, {force: true}); return; }
  if (!validModelId(model)) throw new Error('Invalid model id');
  await mkdir(stateDirectory, {recursive: true});
  await writeFile(`${file}.tmp`, JSON.stringify({model}) + '\n');
  await rename(`${file}.tmp`, file);
}
