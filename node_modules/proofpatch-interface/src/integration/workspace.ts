import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type {PatchEngine} from '../../../../core/engine/src/engine';
import {isProtectedPath,isSecretPath,normalizeRel} from '../../../../core/engine/src/paths';
import {isExcludedPath,isSensitiveFile} from '../../../../core/workspace/src/tools/path-utils';
import type {WorkspaceViewAdapter} from '../../../../core/workspace/src/types';

export const hidden = (rel:string) => isProtectedPath(rel) || isSecretPath(rel) || isExcludedPath(rel) || isSensitiveFile(rel);

export class EngineWorkspace implements WorkspaceViewAdapter {
 constructor(readonly engine:PatchEngine) {}
 async relative(absolute:string) {
  if(path.resolve(absolute)===this.engine.root)return '';
  const rel=normalizeRel(this.engine.root,absolute);
  if(hidden(rel))throw new Error('Path is excluded from the workspace view.');
  let current=this.engine.root;
  for(const part of rel.split('/')){
   current=path.join(current,part);
   if(await this.engine.fs.kind(current)==='symlink')throw new Error('Symbolic links are outside the text workspace view.');
  }
  return rel;
 }
 async readFile(absolute:string){return this.engine.view.readFile(await this.relative(absolute));}
 async fileExists(absolute:string){return (await this.fileStat(absolute))!==null;}
 async fileStat(absolute:string){
  const rel=await this.relative(absolute);
  const staged=this.engine.peekStaged();
  const entry=staged.get(rel);
  if(entry)return entry.kind==='delete'?null:{isFile:true,isDirectory:false,size:Buffer.byteLength(entry.content??'')};
  if([...staged].some(([p,e])=>p.startsWith(rel+'/')&&e.kind==='write'))return {isFile:false,isDirectory:true,size:0};
  try {
   const stat=await fs.lstat(absolute);
   return {isFile:stat.isFile(),isDirectory:stat.isDirectory(),size:stat.size};
  } catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 }
 async readDirectory(absolute:string){
  const rel=await this.relative(absolute);
  const prefix=rel?rel+'/':'';
  const entries=new Set<string>();
  if(await this.engine.fs.kind(absolute)==='dir'){
   for(const item of await this.engine.fs.readdir(absolute)){
    if((item.isDir||item.isFile)&&!hidden(prefix+item.name))entries.add(item.name);
   }
  }
  for(const [p,e] of this.engine.peekStaged()){
   if(!p.startsWith(prefix)||hidden(p))continue;
   const [name,...rest]=p.slice(prefix.length).split('/');
   if(e.kind==='write')entries.add(name);
   else if(!rest.length)entries.delete(name);
  }
  return [...entries].sort();
 }
}
