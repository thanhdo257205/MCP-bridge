import { spawn, type ChildProcess } from 'node:child_process';

type Spawn = (command: string, args: string[], options: {detached: boolean; stdio: 'ignore'; windowsHide: boolean}) => ChildProcess;
const LOCAL_UI = /^http:\/\/127\.0\.0\.1:\d{1,5}\/ui$/;

/** The command that hands a URL to the user's default browser. No shell is involved, so nothing in the URL can be interpreted. */
export function browserCommand(platform: NodeJS.Platform, url: string): {command: string; args: string[]} {
  if (platform === 'win32') return {command: 'rundll32', args: ['url.dll,FileProtocolHandler', url]};
  if (platform === 'darwin') return {command: 'open', args: [url]};
  return {command: 'xdg-open', args: [url]};
}

/** Opens the local web UI in the default browser. Only that one URL shape is accepted. Resolves to false if the opener is missing or fails. */
export function openBrowser(url: string, options: {platform?: NodeJS.Platform; spawnImpl?: Spawn} = {}): Promise<boolean> {
  if (!LOCAL_UI.test(url)) return Promise.resolve(false);
  const {command, args} = browserCommand(options.platform ?? process.platform, url);
  return new Promise(resolve => {
    try {
      const child = (options.spawnImpl ?? spawn)(command, args, {detached: true, stdio: 'ignore', windowsHide: true});
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
