import {isEventDelta,mergeEventDelta,type TrueForgeApi} from '@truefoundry/trueforge-sdk';
import type {AgentEvent,Request,Services} from '../contracts';
import type {RuntimePort,StreamEvent} from './transport';
import {connectionError,redact} from './errors';
import {evidenceEvents} from './evidence';
export interface Approval {name:string;arguments:string;server?:string;toolCallId:string}
export interface AgentOptions {
 spec:TrueForgeApi.AgentSpec; mcpServer?:string;
 approve:(call:Approval,signal:AbortSignal)=>Promise<boolean>;
 cleanupRequest?:(requestId:string)=>Promise<void>;
 cancellationTimeoutMs?:number;
}
interface Active {id:string;session?:string;ready:Promise<void>;release:()=>void;cancelled:boolean;cancelPromise?:Promise<void>;terminal:boolean;submitted:boolean}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function textContent(content:TrueForgeApi.ModelMessageEventContent|null|undefined):string{
 if(typeof content==='string')return content;
 return content?.map(p=>'text' in p?p.text:'refusal' in p?p.refusal:'').join('')??'';
}
type AgentService=Services['agent'];
export class TrueForgeAgent implements AgentService {
 private cleanupFailed=false;private session?:string;private workspaceKey?:string;private active?:Active;
 constructor(private port:RuntimePort,private options:AgentOptions){}
 reset(){if(this.active)throw new Error('Stop the current request first.');this.session=undefined;this.workspaceKey=undefined;}
 async cancel(requestId:string):Promise<void>{
  const active=this.active;if(!active||active.id!==requestId)return;
  active.cancelled=true;
  if(!active.cancelPromise)active.cancelPromise=(async()=>{
   // Never abort session/turn creation before knowing which session to cancel.
   await active.ready;
   if(active.session&&active.submitted&&!active.terminal){
    await this.port.cancel(active.session);
    const deadline=Date.now()+(this.options.cancellationTimeoutMs??20000);
    while(true){
     const status=await this.port.status(active.session);
     if(!status||['done','cancelled','error'].includes(status)){active.terminal=true;break;}
     if(Date.now()>=deadline)throw new Error('TrueForge accepted cancellation but did not confirm a terminal turn. Check the runtime and MCP server before reconnecting.');
     await pause(150);
    }
   }
   await this.options.cleanupRequest?.(active.id);
  })().catch(e=>{this.session=undefined;this.cleanupFailed=true;throw connectionError(e);});
  return active.cancelPromise;
 }
 async *run(request:Request,signal:AbortSignal):AsyncIterable<AgentEvent>{
  if(this.cleanupFailed)throw new Error('Previous cancellation cleanup failed. Check the runtime and reload before sending another request.');
  if(this.active)throw new Error('A TrueForge request is already active.');
  let release!:()=>void;const ready=new Promise<void>(r=>release=r);
  const a:Active={id:request.id,ready,release,cancelled:false,terminal:false,submitted:false};this.active=a;
  const abort=()=>{void this.cancel(request.id).catch(()=>{/* controller awaits cancel and reports failure */});};signal.addEventListener('abort',abort,{once:true});
  const events=new Map<string,StreamEvent>(),calls=new Map<string,TrueForgeApi.ToolCall>(),announced=new Set<string>();
  let turnId='',lastEvent='',pending:TrueForgeApi.ToolApprovalRequiredEvent[]=[];let textSeen=false;
  try{
   if(signal.aborted){a.release();return;}
   const key=JSON.stringify(request.workspaceUris);
   if(this.workspaceKey!==key){this.session=undefined;this.workspaceKey=key;}
   yield {type:'progress',message:this.session?'Continuing TrueForge session…':'Creating TrueForge session…'};
   if(!this.session)this.session=await this.port.createSession(this.options.spec);
   a.session=this.session;
   if(a.cancelled||signal.aborted){a.release();return;}
   yield {type:'progress',message:`TrueForge session ${a.session}`};
   const content=JSON.stringify({requestId:request.id,mode:request.mode,workspaceUris:request.workspaceUris,instruction:request.instruction,selection:request.selection??null});
   a.submitted=true;
   let stream=await this.port.start(a.session,content);a.release();
   while(true){
    let paused=false;
    for await(const e of stream){
     if(e.type==='turn.created')turnId=e.turnId;
     if(e.type==='turn.done')a.terminal=true;
     if(a.cancelled||signal.aborted){continue;}
     lastEvent=e.id;
     if(isEventDelta(e)){const base=events.get(e.id);if(base)mergeEventDelta(base,e);}else events.set(e.id,e);
     if(events.size>10000)throw new Error('Turn exceeded the event limit. Start a smaller task.');
     const merged=events.get(e.id);
     if(merged?.type==='model.message')for(const call of merged.toolCalls??[]){
      if(!call.id)continue;calls.set(call.id,call);
      if(!announced.has(call.id)&&call.function?.name){announced.add(call.id);yield {type:'tool',id:call.id,name:call.toolInfo?.name??call.function.name,status:'running',detail:'Requested by TrueForge'};}
     }
     switch(e.type){
      case 'model.message.delta': if(e.threadId==='main'&&e.content){textSeen=true;yield {type:'text',delta:e.content};}break;
      case 'model.message':{const text=textContent(e.content);if(e.threadId==='main'&&text){textSeen=true;yield {type:'text',delta:text};}break;}
      case 'tool.response':{
       const call=calls.get(e.toolCallId);
       let failed=false;try{failed=JSON.parse(e.content)?.isError===true;}catch{/* plain tool output */}
       yield {type:'tool',id:e.toolCallId,name:call?.toolInfo?.name??call?.function.name??'MCP tool',status:failed?'failed':'completed',detail:failed?'Tool reported an error. See the agent response.':'Tool response received'};
       if(!failed&&call?.toolInfo?.type==='mcp'&&call.toolInfo.serverName===this.options.mcpServer)yield* evidenceEvents(e.content,request.id);
       break;
      }
      case 'mcp.initialize':yield {type:'progress',message:`MCP connected: ${e.mcpServers.map(s=>s.name).join(', ')}`};break;
      case 'tool.approval_required':pending.push(e);yield {type:'progress',message:'Waiting for tool approval…'};break;
      case 'tool.response_required':throw new Error('The agent requested an unsupported client-side tool. Disable ask-user/generative tools in its configuration.');
      case 'mcp.auth_required':throw new Error('The MCP connector requires sign-in. Complete authentication in TrueForge Settings → Connectors, then retry.');
      case 'turn.update':if(e.state.status==='paused')paused=true;break;
      case 'turn.done':
       if(e.state.status==='error')throw connectionError(new Error(e.state.message));
       if(e.state.status==='cancelled')throw new Error(`TrueForge stopped the turn (${e.state.reason}).`);
       if(e.state.status==='done'&&!textSeen){const text=textContent(e.state.output?.content);if(text)yield {type:'text',delta:text};}
       yield {type:'progress',message:'TrueForge turn completed.'};break;
     }
     if(paused)break;
    }
    if(a.cancelled||signal.aborted)break;
    if(a.terminal)break;
    if(!paused)throw new Error('TrueForge stream ended before completion. The turn is being cancelled; retry after checking the server.');
    if(!turnId||!pending.length)throw new Error('TrueForge paused without a supported approval request. Check its agent configuration.');
    const answers:TrueForgeApi.TurnUserEventMessage[]=[];
    for(const approval of pending)for(const ref of approval.toolCalls){
     const call=calls.get(ref.id);
     if(!call)throw new Error('Cannot inspect the requested tool call. Approval was not sent.');
     const allowed=await this.options.approve({name:call.toolInfo?.name??call.function.name,arguments:redact(call.function.arguments),server:call.toolInfo?.type==='mcp'?call.toolInfo.serverName:undefined,toolCallId:ref.id},signal);
     if(a.cancelled||signal.aborted)break;
     answers.push({type:'user.tool_approval',threadId:approval.threadId,toolCallId:ref.id,approval:allowed?{status:'allow'}:{status:'deny',reason:'Denied by the developer'}});
    }
    if(a.cancelled||signal.aborted)break;
    pending=[];
    stream=await this.port.resume(a.session,turnId,lastEvent,answers,signal);
   }
  }catch(error){
   a.release();
   if(!signal.aborted){
    try{await this.cancel(request.id);}catch(cleanup){throw new Error(`${connectionError(error).message} Cleanup failed: ${connectionError(cleanup).message}`);}
    throw connectionError(error);
   }
  }finally{
   a.release();
   if(signal.aborted||a.cancelled){try{await this.cancel(request.id);}catch{/* preserve the primary error; Stop separately awaits cleanup */}finally{signal.removeEventListener('abort',abort);if(this.active===a)this.active=undefined;}}
   else{signal.removeEventListener('abort',abort);if(this.active===a)this.active=undefined;}
  }
 }
}
