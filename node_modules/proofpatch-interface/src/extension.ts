import * as vscode from 'vscode';
import {createMember5Validation,type Member5Options} from './validation/adapter';
import {approveValidation} from './validation/host';
import { randomBytes } from 'node:crypto';
import {startIntegration} from './integration/host';
import { Controller } from './controller';
import { demoServices } from './demo';
import {liveServices,registerRuntimeCommands} from './trueforge/connect';
import type {LiveComponents} from './contracts';
import { clientMessage } from './protocol';
import type { ProofPatchAPI, Selection, Services } from './contracts';
export function activate(context:vscode.ExtensionContext):ProofPatchAPI {
 let view:vscode.WebviewView|undefined;
 let activeServices:Services|undefined;
 const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,60);status.command='proofpatch.open';status.show();
 const controller=new Controller(state=>{
  status.text=`$(shield) ProofPatch: ${state.busy??state.status}`;
  status.tooltip=state.error??state.service;
  void view?.webview.postMessage({type:'state',state});
 });
 const bind=(services:Services)=>{controller.connect(services);activeServices=services;return {dispose(){if(activeServices===services){void controller.stop().finally(()=>controller.disconnect());activeServices=undefined;}}};};
 const createValidation=(options:Member5Options)=>createMember5Validation(options,approveValidation);
 let connecting=false;
 let embedded:Awaited<ReturnType<typeof startIntegration>>|undefined;
 context.subscriptions.push({dispose:()=>embedded?.dispose()});
 const connectLive=async(components?:LiveComponents)=>{
  if(connecting||controller.locked)throw new Error('Wait for the current operation.');
  connecting=true;
  let pending:typeof embedded;
  try{
   if(!components){
    if(!embedded)pending=await startIntegration(context);
    components=(pending??embedded)!.components;
   }
   const host=pending??(components===embedded?.components?embedded:undefined);
   const configured=components.member5?{...components,validation:createValidation(components.member5)}:components;
   const services=await liveServices(context,configured,host);
   if(host)services.agent=host.scope(services.agent);
   const binding=bind(services);
   if(pending){embedded=pending;pending=undefined;}
   await open();
   return binding;
  }finally{pending?.dispose();connecting=false;}
 };
 const documents=new Map<string,string>();
 const contentProvider:vscode.TextDocumentContentProvider={provideTextDocumentContent(uri){return documents.get(uri.toString())??'Preview expired. Reopen the diff from ProofPatch.';}};
 const open=async()=>{await vscode.commands.executeCommand('workbench.view.extension.proofpatch');await vscode.commands.executeCommand('proofpatch.chat.focus');};
 const workspaces=()=>vscode.workspace.workspaceFolders?.map(f=>f.uri.toString())??[];
 const trusted=()=>{if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before sending code to ProofPatch.');};
 const showDiff=async(fileId:string)=>{
  const r=controller.state.review, f=r?.files.find(f=>f.id===fileId);if(!r||!f)throw new Error('Diff no longer available.');
  // Immutable virtual documents, never a writable file: the engine supplies both sides.
  const key=`/${encodeURIComponent(r.id)}/${r.revision}/${encodeURIComponent(f.id)}/${encodeURIComponent(f.path.split('/').at(-1)??'preview')}`;
  const left=vscode.Uri.from({scheme:'proofpatch-diff',path:key,query:'original'}),right=left.with({query:'proposed'});
  documents.set(left.toString(),f.original);documents.set(right.toString(),f.proposed);
  // Bound retained snapshots; current previews remain available during ordinary review.
  while(documents.size>100)documents.delete(documents.keys().next().value!);
  await vscode.commands.executeCommand('vscode.diff',left,right,`ProofPatch • ${f.path} (proposal)`,{preview:true});
 };
 const inline=async()=>{
  trusted();const editor=vscode.window.activeTextEditor;
  if(!editor||editor.selection.isEmpty||editor.document.uri.scheme==='proofpatch-diff')throw new Error('Select code in a workspace file first.');
  const {document,selection}=editor;
  if(!vscode.workspace.getWorkspaceFolder(document.uri))throw new Error('Select code in an open workspace folder.');
  const captured:Selection={uri:document.uri.toString(),languageId:document.languageId,version:document.version,text:document.getText(selection),range:{start:{line:selection.start.line,character:selection.start.character},end:{line:selection.end.line,character:selection.end.character}}};
  if(captured.text.length>64000)throw new Error('Select less than 64,000 characters.');
  const instruction=await vscode.window.showInputBox({title:'ProofPatch — Edit Selection',prompt:'Describe the change. Proposed edits will be reviewed before Apply.',ignoreFocusOut:true,validateInput:s=>!s.trim()?'Enter an instruction':s.length>32000?'Instruction is too long':undefined});
  if(!instruction?.trim())return;
  if(document.version!==captured.version)throw new Error('The document changed while you entered the instruction. Select the code again.');
  await open();await controller.start({instruction:instruction.trim(),mode:'inline',selection:captured,workspaceUris:workspaces()});
  const first=controller.state.review?.files[0];if(first)await showDiff(first.id);
 };
 const apply=async()=>{
  trusted();if(controller.locked)throw new Error('Wait for the current operation.');
  const r=controller.state.review;if(!r)throw new Error('No review available.');
  const revision=r.revision,id=r.id;
  const accepted=r.files.reduce((n,f)=>n+f.hunks.filter(h=>h.state==='accepted').length,0);
  if(!accepted||r.files.some(f=>f.hunks.some(h=>h.state==='proposed')))throw new Error('Accept at least one hunk and review all remaining hunks first.');
  const action=controller.state.demo?'Simulate Apply':'Apply';
  const answer=await vscode.window.showWarningMessage(`${action} ${accepted} accepted hunk(s)? ${controller.state.validation?.state==='FRESH'?'Checks passed for the recorded snapshot.':'Current staged changes do not have fresh passing validation.'}`,{modal:true},action);
  if(answer!==action)return;
  if(controller.state.review?.id!==id||controller.state.review.revision!==revision)throw new Error('Review changed during confirmation. Inspect it again.');
  await controller.apply();
 };
 const undo=async()=>{trusted();if(controller.locked)throw new Error('Wait for the current operation.');if(await vscode.window.showWarningMessage('Undo the last ProofPatch apply? The patch engine must check for newer edits.',{modal:true},'Undo')==='Undo')await controller.undo();};
 const demo=()=>{controller.connect(demoServices());activeServices=undefined;};
 const guard=(fn:()=>unknown)=>async()=>{try{await fn();}catch(e){controller.fail(e);void vscode.window.showErrorMessage(e instanceof Error?e.message:String(e));}};
 context.subscriptions.push(status,vscode.workspace.registerTextDocumentContentProvider('proofpatch-diff',contentProvider),
  vscode.window.registerWebviewViewProvider('proofpatch.chat',{
   resolveWebviewView(v){
    view=v;v.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist')]};
    const nonce=randomBytes(24).toString('hex');const resource=(name:string)=>v.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'dist',name)).toString();
    v.webview.html=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${v.webview.cspSource}; script-src 'nonce-${nonce}';"><title>ProofPatch</title><link rel="stylesheet" href="${resource('webview.css')}"></head><body><div id="root"></div><script nonce="${nonce}" src="${resource('webview.js')}"></script></body></html>`;
    const subscription=v.webview.onDidReceiveMessage(async(raw:unknown)=>{
     const parsed=clientMessage.safeParse(raw);if(!parsed.success){controller.fail(new Error('Invalid interface message.'));return;}
     const m=parsed.data;
     try{
      switch(m.type){
       case 'ready':controller.emit();break;
       case 'send':trusted();await controller.start({instruction:m.instruction,mode:'chat',workspaceUris:workspaces()});break;
       case 'stop':await controller.stop();break;
       case 'demo':demo();break;
       case 'connect':await connectLive();break;
       case 'inline':await inline();break;
       case 'decide':await controller.decide(m.reviewId,m.revision,m.fileId,m.hunkId,m.decision);break;
       case 'diff':await showDiff(m.fileId);break;
       case 'apply':await apply();break;
       case 'undo':await undo();break;
       case 'validate':await controller.validate();break;
       case 'evidence':{
        const item=controller.state.context.find(x=>x.id===m.id);if(!item?.uri)throw new Error('This evidence has no source URI.');
        const uri=vscode.Uri.parse(item.uri);
        if(!['file','vscode-remote'].includes(uri.scheme)||!vscode.workspace.getWorkspaceFolder(uri))throw new Error('Evidence must refer to a file in the current workspace.');
        const doc=await vscode.workspace.openTextDocument(uri);const line=Math.min(doc.lineCount-1,Math.max(0,(item.startLine??1)-1));
        await vscode.window.showTextDocument(doc,{selection:new vscode.Range(line,0,line,0)});break;
       }
      }
     }catch(e){controller.fail(e);}
    });
    v.onDidDispose(()=>{subscription.dispose();if(view===v)view=undefined;});
   }
  }),
  vscode.commands.registerCommand('proofpatch.open',guard(open)),vscode.commands.registerCommand('proofpatch.inlineEdit',guard(inline)),
  vscode.commands.registerCommand('proofpatch.stop',guard(()=>controller.stop())),vscode.commands.registerCommand('proofpatch.apply',guard(apply)),
  vscode.commands.registerCommand('proofpatch.undo',guard(undo)),vscode.commands.registerCommand('proofpatch.demo',guard(async()=>{demo();await open();})),
  {dispose(){void controller.stop();documents.clear();}}
 );
 registerRuntimeCommands(context,guard(()=>connectLive()));
 controller.emit();
 return {version:1,createValidation,connect(services){trusted();return bind(services);},connectTrueForge:connectLive};
}
