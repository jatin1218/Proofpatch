import * as vscode from 'vscode';
import type {LiveComponents,Services} from '../contracts';
import {agentSpec,localBaseUrl} from './spec';
import {SdkTransport,sdkClient} from './transport';
import {TrueForgeAgent,type Approval} from './agent';
import {connectionError} from './errors';
const config=()=>vscode.workspace.getConfiguration('proofpatch.trueforge');
async function approve(call:Approval,signal:AbortSignal):Promise<boolean>{
 if(signal.aborted)return false;
 // QuickPick can be disposed immediately on Stop, unlike a modal notification.
 return new Promise(resolve=>{
  const pick=vscode.window.createQuickPick();let settled=false;
  const done=(value:boolean)=>{if(settled)return;settled=true;signal.removeEventListener('abort',cancel);pick.dispose();resolve(value);};
  const cancel=()=>done(false);
  pick.title=`ProofPatch: allow ${call.name}?`;
  pick.placeholder=`${call.server??'TrueForge'} · Inspect the full arguments before allowing`;
  pick.items=[{label:'Deny',description:'Do not run this tool call'},{label:'Inspect arguments',description:'Open a read-only preview of the tool request'},{label:'Allow once',description:'Approve only this exact tool call'}];
  pick.ignoreFocusOut=true;
  pick.onDidAccept(async()=>{
   const label=pick.selectedItems[0]?.label;
   if(label==='Inspect arguments'){
    const doc=await vscode.workspace.openTextDocument({content:JSON.stringify({server:call.server,tool:call.name,arguments:call.arguments},null,2),language:'json'});
    await vscode.window.showTextDocument(doc,{preview:true,preserveFocus:true});return;
   }
   done(label==='Allow once');
  });
  pick.onDidHide(()=>done(false));signal.addEventListener('abort',cancel,{once:true});pick.show();
 });
}
export async function liveServices(context:vscode.ExtensionContext,components?:LiveComponents, endpoint?:{name:string;url:string}):Promise<Services>{
 if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before connecting TrueForge.');
 const baseUrl=localBaseUrl(config().get<string>('baseUrl','http://localhost:8790'));
 const client=sdkClient(baseUrl,await context.secrets.get('proofpatch.trueforge.token'));
 try{
  const [{data:models},{data:servers}]=await Promise.all([client.models.list({timeoutInSeconds:10}),client.mcpServers.list({timeoutInSeconds:10})]);
  let model=config().get<string>('model','');
  if(!models.some(m=>m.name===model)){
   if(!models.length)throw new Error('No models configured. Open TrueForge → Settings → Models, configure Google with your Gemini API key, then reconnect.');
   const selected=await vscode.window.showQuickPick(models.sort((a,b)=>Number(/gemini/i.test(b.name))-Number(/gemini/i.test(a.name))).map(m=>({label:m.name,description:m.modelId})),{title:'ProofPatch: choose the Gemini model configured in TrueForge',ignoreFocusOut:true});
   if(!selected)throw new Error('Connection cancelled.');model=selected.label;await config().update('model',model,vscode.ConfigurationTarget.Global);
  }
  let mcp=config().get<string>('mcpServer','');
  if(endpoint){
   if(!servers.some(s=>s.name===endpoint.name&&s.url===endpoint.url)){
    await client.settings.mcpServers.create({manifest:{type:'remote',name:endpoint.name,url:endpoint.url,description:'ProofPatch local workspace session'}});
   }
   mcp=endpoint.name;
  }
  if(!endpoint&&mcp&&!servers.some(s=>s.name===mcp))throw new Error(`MCP connector "${mcp}" is not registered in TrueForge. Register Member 2's endpoint or clear proofpatch.trueforge.mcpServer.`);
  if(!mcp){
   const selected=await vscode.window.showQuickPick([{label:'Chat / selection only',description:'No repository tools; connect Member 2 later',server:''},...servers.map(s=>({label:s.name,description:'Registered MCP server',server:s.name}))],{title:'ProofPatch: choose Member 2’s MCP connector',ignoreFocusOut:true});
   if(!selected)throw new Error('Connection cancelled.');mcp=selected.server;
   if(mcp)await config().update('mcpServer',mcp,vscode.ConfigurationTarget.Global);
  }
  const yaml=new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri,'agent','proofpatch.agent.yaml')));
  const spec=agentSpec(yaml,model,mcp||undefined);
  if(!components?.patches)for(const server of spec.mcpServers??[])server.enableTools=['@read-only'];
  const agent=new TrueForgeAgent(new SdkTransport(client),{spec,mcpServer:mcp||undefined,approve,cleanupRequest:components?.cleanupRequest});
  const missing=async():Promise<never>=>{throw new Error('Member 4 patch engine is not connected. Register it with api.connectTrueForge(components) before accepting, applying or undoing patches.');};
  return {label:`TrueForge · ${model} · ${mcp||'no MCP tools'}`,agent,
   capabilities:{patches:!!components?.patches,validation:!!components?.validation},
   patches:components?.patches??{decide:missing,apply:missing,undo:missing,async discard(){}},
   validation:components?.validation??{async run(review){return {state:'NOT RUN',snapshotId:review.snapshotId,summary:'Member 5 validation runner is not connected. No tests ran.'};}},subscribe:components?.subscribe};
 }catch(e){throw connectionError(e);}
}
export function registerRuntimeCommands(context:vscode.ExtensionContext,connect:()=>Promise<unknown>){
 context.subscriptions.push(
  vscode.commands.registerCommand('proofpatch.connectTrueForge',connect),
  vscode.commands.registerCommand('proofpatch.startTrueForge',async()=>{
   await vscode.workspace.fs.createDirectory(context.globalStorageUri);
   const terminal=vscode.window.createTerminal({name:'ProofPatch • TrueForge',cwd:context.globalStorageUri.fsPath});
   terminal.show();terminal.sendText('npx --yes @truefoundry/trueforge@0.185.1');
  }),
  vscode.commands.registerCommand('proofpatch.openTrueForge',async()=>{try{await vscode.env.openExternal(vscode.Uri.parse(localBaseUrl(config().get<string>('baseUrl','http://localhost:8790'))));}catch(e){void vscode.window.showErrorMessage(connectionError(e).message);}}),
  vscode.commands.registerCommand('proofpatch.setTrueForgeToken',async()=>{
   const token=await vscode.window.showInputBox({title:'TrueForge access token (only if server login is enabled)',prompt:'This is a TrueForge token, NOT a Gemini API key. Leave blank to remove.',password:true,ignoreFocusOut:true});
   if(token===undefined)return;if(token)await context.secrets.store('proofpatch.trueforge.token',token);else await context.secrets.delete('proofpatch.trueforge.token');
   void vscode.window.showInformationMessage('TrueForge access token updated. Reconnect to use it.');
  }),
  vscode.commands.registerCommand('proofpatch.registerMcp',async()=>{
   try{
    const name=await vscode.window.showInputBox({title:'Member 2 MCP connector name',value:'proofpatch-workspace',validateInput:s=>/^[a-zA-Z0-9_.-]+$/.test(s)?undefined:'Use letters, digits, dots, underscores or hyphens.'});if(!name)return;
    const url=await vscode.window.showInputBox({title:'Member 2 Streamable HTTP MCP endpoint',placeHolder:'http://localhost:3001/mcp',prompt:'Start Member 2’s MCP server first. This registers its existing endpoint.'});if(!url)return;
    const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Use an HTTP(S) MCP URL without embedded credentials.');
    const client=sdkClient(localBaseUrl(config().get<string>('baseUrl','http://localhost:8790')),await context.secrets.get('proofpatch.trueforge.token'));
    await client.settings.mcpServers.create({manifest:{type:'remote',name,description:'ProofPatch workspace tools managed by Member 2',url:u.toString()}});
    await config().update('mcpServer',name,vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('MCP connector registered. Run ProofPatch: Connect TrueForge.');
   }catch(e){void vscode.window.showErrorMessage(connectionError(e).message);}
  })
 );
}
