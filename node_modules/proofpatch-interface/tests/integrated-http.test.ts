import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {PatchEngine} from '../../../core/engine/src/engine';
import {startEndpoint} from '../src/integration/http';
import {ReviewSession} from '../src/integration/review';
import {evidenceEvents} from '../src/trueforge/evidence';

test('HTTP MCP client discovers tools and receives a review for its active turn',async t=>{
 const root=await mkdtemp(join(tmpdir(),'proofpatch-http-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'sample.txt'),'original\n');
 const session=new ReviewSession(new PatchEngine({workspaceRoot:root}));
 const requestId=randomUUID();
 session.turn=requestId;
 const endpoint=await startEndpoint(session);
 const client=new Client({name:'integration-test',version:'1'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
  const tools=await client.listTools();
  assert.ok(tools.tools.some(t=>t.name==='propose_file'));
  const result=await client.callTool({name:'propose_file',arguments:{requestId,path:'sample.txt',content:'changed\n'}});
  const [event]=evidenceEvents(JSON.stringify(result),requestId);
  assert.ok(event?.type==='review');
  assert.equal(event.review.files[0].original,'original\n');
  assert.equal(event.review.files[0].proposed,'changed\n');
  assert.equal(await readFile(join(root,'sample.txt'),'utf8'),'original\n');
 }finally{await client.close();endpoint.dispose();}
});
