import { createHash } from 'node:crypto';
import type { Review, Services } from './contracts';
const sleep=(signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 if(signal.aborted){reject(new Error('Cancelled'));return;}
 const cancel=()=>{clearTimeout(timer);reject(new Error('Cancelled'));};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},300);signal.addEventListener('abort',cancel,{once:true});
});
/** Isolated fixture: never reads, writes, or executes code in the workspace. */
export function demoServices():Services {
 let review:Review|undefined;let counter=0;
 const get=(id:string,revision?:number)=>{if(!review||review.id!==id||(revision!==undefined&&review.revision!==revision))throw new Error('Demo review revision mismatch');return review;};
 const copy=()=>structuredClone(review!);
 const snapshot=()=>{review!.revision++;review!.snapshotId=createHash('sha256').update(JSON.stringify(review!.files.map(f=>f.hunks))).digest('hex');return copy();};
 return {
  label:'Demo fixtures · no workspace writes',demo:true,
  agent:{
   async *run(request,signal){
    yield {type:'progress',message:'Demo: gathering an example context trail.'};await sleep(signal);
    if(request.instruction.toLowerCase().includes('/error'))throw new Error('Demo: TrueForge endpoint unavailable. No workspace changes were made.');
    const before=request.selection?.text??'def greet(name):\n    return "Hello " + name\n';
    const after=before+'\n# Demo proposal: replace with your agent-generated change.\n';
    const path=request.selection?.uri.split('/').at(-1)??'example.py';
    yield {type:'tool',id:'search',name:'workspace.search',status:'running',detail:'Simulated context lookup'};await sleep(signal);
    yield {type:'context',budget:8000,used:before.length,items:[{id:'context-1',uri:request.selection?.uri,path,startLine:(request.selection?.range.start.line??0)+1,reason:'Demo: selected code or example fixture; no repository search was executed.',characters:before.length}]};
    yield {type:'tool',id:'search',name:'workspace.search',status:'completed',detail:'Fixture context ready'};
    for(const delta of ['Here is a simulated proposal. ','Review the hunk, accept or reject it, ','then inspect validation evidence. This demo never changes your files.']){await sleep(signal);yield {type:'text',delta};}
    review={id:`demo-${++counter}`,revision:0,snapshotId:'demo-base',canUndo:false,applied:false,files:[{id:'file-1',path,original:before,proposed:after,hunks:[{id:'hunk-1',oldStart:1,newStart:1,before,after,state:'proposed'}]}]};
    yield {type:'review',review:copy()};
   },async cancel(){/* Fixture timers observe AbortSignal. */}
  },
  patches:{
   async decide(id,revision,fileId,hunkId,decision){const r=get(id,revision);const h=r.files.find(f=>f.id===fileId)?.hunks.find(h=>h.id===hunkId);if(!h)throw new Error('Unknown hunk');h.state=decision;return snapshot();},
   async apply(id,revision){const r=get(id,revision);for(const f of r.files)for(const h of f.hunks)if(h.state==='accepted')h.state='applied';r.applied=true;r.canUndo=true;return snapshot();},
   async undo(id,revision){const r=get(id,revision);for(const f of r.files)for(const h of f.hunks)if(h.state==='applied')h.state='accepted';r.applied=false;r.canUndo=false;return snapshot();},
   async discard(id){get(id);review=undefined;}
  },
  validation:{async run(r,signal){await sleep(signal);return {state:'NOT RUN',snapshotId:r.snapshotId,summary:'Demo only. No tests or shell commands ran. Connect Member 5 to obtain real validation evidence.'};}}
 };
}
