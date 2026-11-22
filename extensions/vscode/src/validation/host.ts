import * as vscode from 'vscode';
import type {ValidationApproval} from './adapter';
export const approveValidation:ValidationApproval=async(checks,signal)=>{
 if(!vscode.workspace.isTrusted||signal.aborted)return false;
 const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(checks.map(({command,required})=>({command:{...command,env:command.env?Object.fromEntries(Object.keys(command.env).map(k=>[k,'[value hidden]'])):undefined},required:required!==false})),null,2)});
 await vscode.window.showTextDocument(document,{preview:true,preserveFocus:true});
 if(signal.aborted)return false;
 return new Promise(resolve=>{
  const pick=vscode.window.createQuickPick();let done=false;
  const finish=(answer:boolean)=>{if(done)return;done=true;signal.removeEventListener('abort',cancel);pick.dispose();resolve(answer);};
  const cancel=()=>finish(false);
  pick.title='ProofPatch: run validation commands?';
  pick.placeholder='Review the command preview. Temp copies isolate input files, but commands have your OS permissions.';
  pick.items=[{label:'Cancel'},{label:'Run checks'}];pick.ignoreFocusOut=true;
  pick.onDidAccept(()=>finish(pick.selectedItems[0]?.label==='Run checks'));
  pick.onDidHide(()=>finish(false));signal.addEventListener('abort',cancel,{once:true});pick.show();
 });
};
