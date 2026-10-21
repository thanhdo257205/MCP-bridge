import {mkdir, readFile, rmdir, stat} from 'node:fs/promises';
import path from 'node:path';

export function pidAlive(pid:number):boolean {
  try {process.kill(pid,0);return true;}
  catch(error) {return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
export async function recoverExecutionLock(stateDirectory:string, options:{isAlive?:(pid:number)=>boolean;log?:(message:string)=>void}={}) {
  const lock=path.join(stateDirectory,'execution.lock'),ownerFile=path.join(stateDirectory,'owner.json');
  let claim=false;
  try {
    const info=await stat(lock).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
    if(!info)return {reclaimed:false,absent:true,reason:'No execution lock exists'};
    const raw=await readFile(ownerFile,'utf8'),owner=JSON.parse(raw) as {server_pid?:unknown;child_pid?:unknown};
    const valid=(pid:unknown):pid is number=>typeof pid==='number'&&Number.isInteger(pid)&&pid>0;
    if(!valid(owner.server_pid)||!valid(owner.child_pid))return {reclaimed:false,absent:false,reason:'Owner must contain both valid server_pid and child_pid; refusing to remove lock'};
    // An older owner file cannot identify a newly acquired lock whose owner write is still pending.
    if((await stat(ownerFile)).mtimeMs<info.birthtimeMs)return {reclaimed:false,absent:false,reason:'Owner record predates this lock; ownership is uncertain'};
    const alive=options.isAlive??pidAlive;
    if(alive(owner.server_pid)||alive(owner.child_pid))return {reclaimed:false,absent:false,reason:'Recorded server or child PID is still alive; refusing to remove lock'};
    await mkdir(path.join(lock,'.reclaim'));claim=true;
    const current=await stat(lock);
    if(current.ino!==info.ino||current.birthtimeMs!==info.birthtimeMs||await readFile(ownerFile,'utf8')!==raw||alive(owner.server_pid)||alive(owner.child_pid)) {
      return {reclaimed:false,absent:false,reason:'Ownership changed during recovery; refusing to remove lock'};
    }
    await rmdir(path.join(lock,'.reclaim'));claim=false;
    await rmdir(lock); // Nonrecursive: unexpected contents make recovery fail closed.
    const reason=`Reclaimed stale execution lock: server PID ${owner.server_pid} and child PID ${owner.child_pid} are both dead`;
    (options.log??console.error)(`[bridge] ${reason}`);
    return {reclaimed:true,absent:false,reason};
  }catch {return {reclaimed:false,absent:false,reason:'Cannot verify lock ownership or safely reclaim it; lock retained'};}
  finally {if(claim)await rmdir(path.join(lock,'.reclaim')).catch(()=>{});}
}
