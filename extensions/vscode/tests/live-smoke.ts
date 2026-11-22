/** Starts a separate local runtime, checks SDK discovery and failure reporting. No model key needed. */
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {sdkClient,SdkTransport} from '../src/trueforge/transport';
import {agentSpec} from '../src/trueforge/spec';
import {TrueForgeAgent} from '../src/trueforge/agent';
async function main(){
 const args=['--yes','@truefoundry/trueforge@0.185.1','--port','18790'];
 const child=spawn(process.platform==='win32'?'npx.cmd':'npx',args,{shell:process.platform==='win32',stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
 let logs='';child.stdout.on('data',b=>logs=(logs+String(b)).slice(-12000));child.stderr.on('data',b=>logs=(logs+String(b)).slice(-12000));
 try{
  const client=sdkClient('http://localhost:18790');const until=Date.now()+45000;let started=false;
  while(Date.now()<until){try{await client.models.list({timeoutInSeconds:1});started=true;break;}catch{await new Promise(r=>setTimeout(r,300));}}
  if(!started)throw new Error('Runtime did not become ready: '+logs);
  const models=await client.models.list(),servers=await client.mcpServers.list();assert.ok(Array.isArray(models.data));assert.ok(Array.isArray(servers.data));
  const spec=agentSpec(readFileSync('agent/proofpatch.agent.yaml','utf8'),'proofpatch-missing-provider/nonexistent');
  const port=new SdkTransport(client);let session:string|undefined;
  const original=port.createSession.bind(port);port.createSession=async s=>{session=await original(s);return session;};
  const agent=new TrueForgeAgent(port,{spec,approve:async()=>false});
  try{
   let failure='';try{for await(const _ of agent.run({id:'smoke',mode:'chat',instruction:'Hello',workspaceUris:[]},new AbortController().signal)){}}
   catch(e){failure=String(e);}
   assert.ok(failure,'Unconfigured provider must fail honestly');console.log('PASS: TrueForge 0.185.1 discovery and missing-provider failure via the real SDK.');console.log('Observed failure:',failure.slice(0,300));
  }finally{if(session)await client.sessions.delete(session);}
 }finally{
  if(child.pid){if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F']);else try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
