import * as vscode from 'vscode';
import * as path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {PatchEngine} from '../../../../core/engine/src/engine';
import {buildPytestCommand, PYTHON_ENV_ALLOWLIST} from '../../../../core/validation/src/python/flask';
import type {LiveComponents,Services,AgentEvent} from '../contracts';
import {createMember5Validation} from '../validation/adapter';
import {approveValidation} from '../validation/host';
import {ReviewSession} from './review';
import {readSnapshot} from './snapshot';
import {startEndpoint} from './http';

export async function startIntegration(context:vscode.ExtensionContext){
 const folders=vscode.workspace.workspaceFolders;
 if(!vscode.workspace.isTrusted||folders?.length!==1||folders[0].uri.scheme!=='file')
  throw new Error('Open one trusted local workspace folder to connect the patch engine.');
 const folder=folders[0];
 const root=folder.uri.fsPath;
 const hash=createHash('sha256').update(root).digest('hex');
 const engine=new PatchEngine({workspaceRoot:root,undoDir:path.join(context.globalStorageUri.fsPath,'undo',hash)});
 const session=new ReviewSession(engine,paths=>vscode.workspace.textDocuments.some(doc=>doc.isDirty&&paths.some(p=>vscode.Uri.joinPath(folder.uri,p).toString()===doc.uri.toString())));
 const recovery=await engine.recover();
 if(recovery.needsAttention.length)throw new Error('An interrupted apply needs manual recovery. Inspect the workspace and undo journal.');
 const key=randomBytes(32);
 const interpreter=()=>vscode.workspace.getConfiguration('proofpatch.validation').get<string>('python','');
 const makeValidation=()=>createMember5Validation({
  getSnapshot:r=>readSnapshot(session,r),checks:interpreter()?[{command:buildPytestCommand({python:interpreter(),sourceRoots:['src','.'],timeoutMs:120000})}]:[],
  environmentAllowlist:PYTHON_ENV_ALLOWLIST,fingerprintKeyProvider:{getFingerprintKey:()=>key}
 },approveValidation);
 let configuredPython=interpreter();
 let runner=makeValidation();
 const validation:Services['validation']={run(review,signal){
  if(configuredPython!==interpreter()){configuredPython=interpreter();runner=makeValidation();}
  return runner.run(review,signal);
 }};
 const endpoint=await startEndpoint(session);
 const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder,'**/*'));
 const events=new vscode.EventEmitter<Extract<AgentEvent,{type:'validation'}>>();
 let change=0;
 const invalidate=async()=>{
  const seq=++change;
  if(!engine.getChangeSet())return;
  const r=session.current();
  const conflicts=await engine.checkConflicts();
  if(seq!==change||engine.getChangeSet()?.id!==r.id)return;
  events.fire({type:'validation',validation:{snapshotId:r.snapshotId,state:conflicts.length?'CONFLICT':'STALE',
   summary:conflicts.length?'Disk conflicts: '+conflicts.map(c=>c.path).join(', '):'Workspace changed. Validate the staged snapshot again.'}});
 };
 const changed=()=>{void invalidate().catch(()=>{});};
 watcher.onDidCreate(changed);watcher.onDidChange(changed);watcher.onDidDelete(changed);
 const components:LiveComponents={patches:session.patches,validation,cleanupRequest:id=>session.cancel(id),subscribe:fn=>events.event(fn)};
 function scope(agent:Services['agent']):Services['agent']{
  return {async *run(request,signal){
   if(request.workspaceUris.length!==1||request.workspaceUris[0]!==folder.uri.toString())
    throw new Error('The workspace changed. Reload the extension and reconnect.');
   session.turn=request.id;
   try{
    for await(const event of agent.run(request,signal))yield event;
    if(!signal.aborted&&engine.getChangeSet())yield {type:'review',review:session.current()};
   }finally{if(session.turn===request.id)session.turn=undefined;}
  },cancel:id=>agent.cancel(id)};
 }
 return {components,scope,url:endpoint.url,name:'proofpatch-'+hash.slice(0,8)+'-'+randomBytes(5).toString('hex'),
  dispose(){session.turn=undefined;watcher.dispose();events.dispose();endpoint.dispose();}};
}
