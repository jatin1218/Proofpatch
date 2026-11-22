import type {Review,Services} from '../contracts';
import {PatchEngine} from '../../../../core/engine/src/engine';
import {EngineWorkspace} from './workspace';

export class ReviewSession {
 readonly workspace:EngineWorkspace;
 private version=0;
 private applied?:{review:Review;undoId:string};
 turn?:string;
 constructor(readonly engine:PatchEngine,private dirty:(paths:string[])=>boolean=()=>false){
  this.workspace=new EngineWorkspace(engine);
  for(const event of ['proposal-updated','hunk-decision','applied','undone','discarded','cancelled'])
   engine.on(event,()=>{this.version++;});
 }
 current():Review {
  const cs=this.engine.getChangeSet();
  if(!cs)throw new Error('No active proposal.');
  return {id:cs.id,revision:this.version,snapshotId:cs.fingerprint,canUndo:false,applied:false,
   files:cs.files.map(f=>({id:f.path,path:f.path,...this.engine.getPreview(f.path),
    hunks:f.hunks.map(h=>({id:h.id,state:h.state,oldStart:h.oldStart,newStart:h.newStart,
     before:h.lines.filter(l=>l.type==='remove').map(l=>l.text).join('\n'),
     after:h.lines.filter(l=>l.type==='add').map(l=>l.text).join('\n')}))}))};
 }
 async propose(requestId:string,path:string,content:string|null){
  if(this.turn!==requestId)throw new Error('This request is no longer active.');
  await this.workspace.relative(this.engine.view.absolute(path));
  const prior=this.engine.getChangeSet()?.id;
  const result=content===null?await this.engine.proposeDelete({path,turnId:requestId}):await this.engine.proposeFile({path,newContent:content,turnId:requestId});
  if(!result.ok)throw new Error(result.message);
  const review=result.changeSetId?this.current():prior?{id:prior,revision:this.version,snapshotId:this.engine.getStagedFingerprint(),files:[],canUndo:false,applied:false}:undefined;
  const events=review?[{type:'review' as const,review}]:[];
  return {proofpatch:{version:1,requestId,events}};
 }
 private check(id:string,revision:number){
  const r=this.current();
  if(r.id!==id||r.revision!==revision)throw new Error('Review changed. Refresh the proposal.');
  return r;
 }
 readonly patches:Services['patches']={
  decide:async(id,revision,file,hunk,decision)=>{
   const r=this.check(id,revision);
   if(!r.files.find(f=>f.id===file)?.hunks.some(h=>h.id===hunk))throw new Error('Unknown review hunk.');
   await this.engine.setHunkDecision(hunk,decision);return this.current();
  },
  apply:async(id,revision)=>{
   const r=this.check(id,revision);
   if(this.dirty(r.files.map(f=>f.path)))throw new Error('Save the affected editor buffers before applying.');
   const result=await this.engine.apply();
   if(!result.ok)throw new Error([result.message,...(result.conflicts??[]).map(c=>c.path)].join('\n'));
   r.applied=true;r.canUndo=true;r.revision=this.version;
   for(const f of r.files)for(const h of f.hunks)if(h.state==='accepted')h.state='applied';
   this.applied={review:r,undoId:result.undoId};return r;
  },
  undo:async(id,revision)=>{
   const a=this.applied;
   if(!a||a.review.id!==id||a.review.revision!==revision)throw new Error('Apply record is outdated.');
   if(this.dirty(a.review.files.map(f=>f.path)))throw new Error('Save affected editors before Undo.');
   const result=await this.engine.undo({undoId:a.undoId});
   if(!result.ok)throw new Error(result.message);
   this.applied=undefined;return {...a.review,revision:this.version,applied:false,canUndo:false,files:[]};
  },
  discard:async id=>{if(this.engine.getChangeSet()?.id===id)await this.engine.discard();}
 };
 async cancel(id:string){if(this.turn===id)this.turn=undefined;await this.engine.cancelTurn(id);}
}
