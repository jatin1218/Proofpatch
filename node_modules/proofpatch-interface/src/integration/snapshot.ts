import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {isSecretPath} from '../../../../core/engine/src/paths';
import {isSensitiveFile} from '../../../../core/workspace/src/tools/path-utils';
import {DEFAULT_IGNORE_DIRS} from '../../../../core/engine/src/overlay';
import type {Review} from '../contracts';
import type {ReviewSnapshot} from '../validation/adapter';
import {ReviewSession} from './review';

// Member 5 can reproduce UTF-8 regular files. Refuse a partial or lossy snapshot.
export async function readSnapshot(session:ReviewSession,review:Review):Promise<ReviewSnapshot>{
 const {engine}=session;
 const check=()=>engine.getChangeSet()?session.current():undefined;
 const start=check();
 const files=new Map<string,string>();
 const limitations:string[]=[];
 let bytes=0;
 const decode=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 async function walk(dir:string){
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
   const abs=path.join(dir,entry.name);
   const rel=path.relative(engine.root,abs).split(path.sep).join('/');
   if(entry.isDirectory()&&DEFAULT_IGNORE_DIRS.includes(entry.name))continue;
   if(entry.isDirectory()){await walk(abs);continue;}
   if(engine.peekStaged().get(rel)?.kind==='delete')continue;
   if(isSecretPath(rel)||isSensitiveFile(rel)){limitations.push(rel);continue;}
   if(!entry.isFile()){limitations.push(rel);continue;}
   const stat=await fs.lstat(abs);
   if((process.platform!=='win32'&&(stat.mode&0o111)!==0)||stat.size>4_000_000){limitations.push(rel);continue;}
   bytes+=stat.size;
   if(bytes>64_000_000||files.size>=20000)throw new Error('Workspace exceeds validation snapshot limits.');
   try{
    const content=decode.decode(await fs.readFile(abs));
    if(content.includes('\0'))limitations.push(rel);else files.set(rel,content);
   }catch{limitations.push(rel);}
  }
 }
 if(start?.id===review.id&&start.revision===review.revision){
  await walk(engine.root);
  for(const [rel,entry] of engine.peekStaged()){
   if(entry.kind==='delete')files.delete(rel);else files.set(rel,entry.content??'');
  }
 }
 const conflictingPaths=(await engine.checkConflicts()).map(c=>c.path);
 const current=check();
 return {reviewId:current?.id??'',revision:current?.revision??-1,snapshotId:current?.snapshotId??'',
  complete:limitations.length===0,limitations,conflictingPaths,
  snapshot:{files:[...files].map(([path,content])=>({path,content}))}};
}
