import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TrueForge} from '@truefoundry/trueforge-sdk';
import {TrueForgeAgent,type AgentOptions} from '../src/trueforge/agent';
import {SdkTransport,type RuntimePort,type StreamEvent} from '../src/trueforge/transport';
import {agentSpec,localBaseUrl} from '../src/trueforge/spec';
import {evidenceEvents} from '../src/trueforge/evidence';
import {connectionError,redact} from '../src/trueforge/errors';
import type {AgentEvent,Request} from '../src/contracts';
const spec=agentSpec(readFileSync('agent/proofpatch.agent.yaml','utf8'),'google/gemini-test','workspace');
const request:Request={id:'req1',instruction:'Explain @symbol greet',mode:'chat',workspaceUris:['file:///workspace']};
const base={createdAt:'2026-11-14T00:00:00Z',threadId:'main'};
const created:StreamEvent={...base,id:'created',type:'turn.created',turnId:'turn1',previousTurnId:null,input:[],state:{status:'running'}};
const done:StreamEvent={...base,id:'done',type:'turn.done',state:{status:'done',output:null,completedAt:base.createdAt,requiredActions:[]}};
const delta=(content:string):StreamEvent=>({...base,id:'message',type:'model.message.delta',content});
const iterable=(events:StreamEvent[])=>({async *[Symbol.asyncIterator](){yield* events;}});
async function collect(agent:TrueForgeAgent,signal=new AbortController().signal,req=request){const out:AgentEvent[]=[];for await(const e of agent.run(req,signal))out.push(e);return out;}
function fixture(events:StreamEvent[]=[created,delta('Hello'),done],options:Partial<AgentOptions>={}){
 const calls:string[]=[];let payload='';
 const port:RuntimePort={async createSession(){calls.push('create');return 'session1';},async start(_s,p){calls.push('start');payload=p;return iterable(events);},async resume(_s,_t,_c,answers){calls.push('resume:'+JSON.stringify(answers));return iterable([delta(' after approval'),done]);},async cancel(){calls.push('cancel');},async status(){calls.push('status');return 'cancelled';}};
 const agent=new TrueForgeAgent(port,{spec,mcpServer:'workspace',approve:async()=>true,...options});return{agent,port,calls,payload:()=>payload};
}
test('agent YAML disables bypass tools and requires explicit MCP approvals',()=>{assert.equal(spec.config?.sandbox?.enabled,false);assert.deepEqual(spec.mcpServers?.[0].requireApprovalForTools,['@all']);assert.equal(spec.config?.iterationLimit,30);});
test('local URL validation refuses external hosts and URL credentials',()=>{assert.equal(localBaseUrl('http://localhost:8790/'),'http://localhost:8790');for(const url of ['https://example.com','http://user:pass@localhost:8790','file:///tmp/x','http://localhost:8790/path'])assert.throws(()=>localBaseUrl(url));});
test('streams deltas once and reuses session across requests',async()=>{const f=fixture();const out=await collect(f.agent);assert.equal(out.filter(e=>e.type==='text').map(e=>e.delta).join(''),'Hello');await collect(f.agent);assert.equal(f.calls.filter(c=>c==='create').length,1);assert.equal(JSON.parse(f.payload()).instruction,request.instruction);});
test('workspace changes create a separate session',async()=>{const f=fixture();await collect(f.agent);await collect(f.agent,undefined,{...request,workspaceUris:['file:///other']});assert.equal(f.calls.filter(c=>c==='create').length,2);});
test('inline selection and request id reach TrueForge in the user message',async()=>{const f=fixture();const selection={uri:'file:///workspace/a.py',languageId:'python',version:2,text:'x=1',range:{start:{line:0,character:0},end:{line:0,character:3}}};await collect(f.agent,undefined,{...request,mode:'inline',selection});assert.deepEqual(JSON.parse(f.payload()).selection,selection);assert.equal(JSON.parse(f.payload()).requestId,'req1');});
const tool:StreamEvent={...base,id:'toolmsg',type:'model.message',toolCalls:[{id:'call1',type:'function',function:{name:'read_file',arguments:'{"path":"a.py"}'},toolInfo:{type:'mcp',serverId:'mcp1',serverName:'workspace',name:'read_file'}}]};
const approval:StreamEvent={...base,id:'approval',type:'tool.approval_required',toolCalls:[{id:'call1',sourceEventId:'toolmsg'}]};
const paused:StreamEvent={...base,id:'pause',type:'turn.update',state:{status:'paused'}};
test('paused approval resumes same turn with an explicit denial',async()=>{const f=fixture([created,tool,approval,paused],{approve:async()=>false});await collect(f.agent);assert.match(f.calls.find(c=>c.startsWith('resume:'))!,/"status":"deny"/);assert.equal(f.calls.filter(c=>c==='start').length,1);});
test('missing tool arguments never receive approval',async()=>{const f=fixture([created,approval,paused]);await assert.rejects(collect(f.agent),/Cannot inspect/);assert.ok(f.calls.includes('cancel'));assert.equal(f.calls.some(c=>c.startsWith('resume:')),false);});
test('selected MCP tool evidence is decoded but assistant JSON is only text',async()=>{const content=JSON.stringify({proofpatch:{version:1,requestId:'req1',events:[{type:'context',items:[],used:0,budget:8000}]}});const f=fixture([created,tool,{...base,id:'response',type:'tool.response',toolCallId:'call1',content},delta(content),done]);const out=await collect(f.agent);assert.equal(out.filter(e=>e.type==='context').length,1);assert.equal(out.filter(e=>e.type==='text').length,1);});
test('evidence ignores wrong request, malformed state and oversized output',()=>{assert.deepEqual(evidenceEvents('{"proofpatch":{"version":1,"requestId":"other","events":[]}}','req1'),[]);assert.equal(evidenceEvents('{"proofpatch":{}}','req1')[0].type,'progress');assert.equal(evidenceEvents('x'.repeat(2_000_001),'req1')[0].type,'progress');});
test('provider error is surfaced, secrets redacted, request not retried',async()=>{const f=fixture([created,{...base,id:'error',type:'turn.done',state:{status:'error',completedAt:base.createdAt,message:'Invalid api_key=secret123'}}]);await assert.rejects(collect(f.agent),e=>String(e).includes('[REDACTED]')&&!String(e).includes('secret123'));assert.equal(f.calls.filter(c=>c==='start').length,1);});
test('premature stream closure cancels the remote turn',async()=>{const f=fixture([created,delta('partial')]);await assert.rejects(collect(f.agent),/before completion/);assert.ok(f.calls.includes('cancel'));});
test('cancel while session is being created waits and does not start a turn',async()=>{
 const f=fixture();let release!:(s:string)=>void;let started!:()=>void;const gate=new Promise<void>(r=>started=r);
 f.port.createSession=()=>{started();return new Promise(r=>release=r);};const abort=new AbortController();const run=collect(f.agent,abort.signal);await gate;abort.abort();const cancel=f.agent.cancel('req1');release('session1');await cancel;await run;assert.equal(f.calls.includes('start'),false);
});
test('cancel during approval dismisses prompt, cancels server and runs cleanup',async()=>{
 let prompted!:()=>void;const ready=new Promise<void>(r=>prompted=r);let cleaned=false;
 const f=fixture([created,tool,approval,paused],{approve:(_call,signal)=>new Promise(resolve=>{prompted();signal.addEventListener('abort',()=>resolve(false),{once:true});}),cleanupRequest:async()=>{cleaned=true;}});
 const abort=new AbortController();const run=collect(f.agent,abort.signal);await ready;abort.abort();await f.agent.cancel('req1');await run;assert.ok(cleaned);assert.ok(f.calls.includes('cancel'));assert.equal(f.calls.some(c=>c.startsWith('resume:')),false);
});
test('cancel polls past accepted acknowledgement until terminal',async()=>{
 const f=fixture();let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.port.start=async()=>({async *[Symbol.asyncIterator](){yield created;started();await gate;yield done;}});let polls=0;f.port.status=async()=>++polls<2?'running':'cancelled';
 const abort=new AbortController();const run=collect(f.agent,abort.signal);await ready;abort.abort();await f.agent.cancel('req1');release();await run;assert.equal(polls,2);
});
test('failed cleanup prevents further requests on the same adapter',async()=>{
 const f=fixture([created],{cleanupRequest:async()=>{throw new Error('cleanup unavailable');}});await assert.rejects(collect(f.agent),/Cleanup failed/);await assert.rejects(collect(f.agent),/Previous cancellation/);
});
test('safe connection diagnostics cover refused connection, auth and quota',()=>{assert.match(connectionError(new Error('fetch failed')).message,/Cannot reach/);assert.match(connectionError({statusCode:401}).message,/authentication/);assert.match(connectionError({statusCode:429}).message,/rate-limited/);assert.equal(redact('Bearer abcd api_key=123'),'Bearer [REDACTED] api_key=[REDACTED]');});
test('actual SDK serializes requests and decodes snake_case SSE events',async()=>{
 const requests:{url:string;method:string;body:any}[]=[];
 const fakeFetch:typeof fetch=async(input,init)=>{
  const url=String(input);const body=init?.body?JSON.parse(String(init.body)):undefined;requests.push({url,method:init?.method??'GET',body});
  if(url.endsWith('/turns')){
   const wire=[{type:'turn.created',id:'c',created_at:base.createdAt,thread_id:null,turn_id:'t',previous_turn_id:null,input:[],state:{status:'running'}},{type:'model.message.delta',id:'m',thread_id:'main',content:'SDK stream works'},{type:'turn.done',id:'d',thread_id:null,created_at:base.createdAt,state:{status:'done',output:null,completed_at:base.createdAt,required_actions:[]}}];
   return new Response(wire.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
  }
  return Response.json({data:{id:'s',last_turn_details:null}});
 };
 const transport=new SdkTransport(new TrueForge({baseUrl:'http://localhost:8790',fetch:fakeFetch,maxRetries:0}));
 const agent=new TrueForgeAgent(transport,{spec,approve:async()=>false});const out=await collect(agent);assert.ok(out.some(e=>e.type==='text'&&e.delta==='SDK stream works'));
 assert.equal(requests[0].body.agent.spec.mcp_servers[0].require_approval_for_tools[0],'@all');assert.equal(requests[1].body.stream,true);assert.equal(requests.length,2);
});
test('SDK opens the continuation stream before submitting approval with wire keys',async()=>{
 const calls:{url:string;body:any}[]=[];
 const client=new TrueForge({baseUrl:'http://localhost:8790',maxRetries:0,fetch:async(input,init)=>{
  const url=String(input);calls.push({url,body:init?.body?JSON.parse(String(init.body)):undefined});
  if(url.includes('/subscribe'))return new Response('',{headers:{'Content-Type':'text/event-stream'}});
  return Response.json({data:[]});
 }});
 const port=new SdkTransport(client);await port.resume('s','t','pause1',[{type:'user.tool_approval',threadId:'main',toolCallId:'call1',approval:{status:'deny',reason:'User denied'}}],new AbortController().signal);
 assert.match(calls[0].url,/subscribe\?after_event_id=pause1/);assert.match(calls[1].url,/\/events$/);assert.equal(calls[1].body.events[0].tool_call_id,'call1');assert.equal(calls[1].body.events[0].thread_id,'main');
});
