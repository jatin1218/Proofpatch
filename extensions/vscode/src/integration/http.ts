import { registrationFor } from '../../../../core/workspace/src/register-tool';
import {randomBytes} from 'node:crypto';
import {createServer as httpServer} from 'node:http';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {createServer} from '../../../../core/workspace/src/server';
import {ReviewSession} from './review';

export async function startEndpoint(session:ReviewSession){
 const route='/mcp/'+randomBytes(32).toString('hex');
 const listener=httpServer(async(req,res)=>{
  if(req.url!==route||req.headers.origin||req.headers.host!==address.host){res.writeHead(404).end();return;}
  if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'}).end();return;}
  const {server}=createServer({workspaceRoot:session.engine.root},session.workspace);
  const register = registrationFor(server);
  register('propose_file','Propose complete text for review. Set content to null to propose deletion.',
   {requestId:z.string().uuid(),path:z.string().min(1).max(512),content:z.string().max(200000).nullable()},
   async({requestId,path,content})=>({content:[{type:'text',text:JSON.stringify(await session.propose(requestId,path,content))}]}));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.once('close',()=>{void server.close().catch(()=>{});});
  try{await server.connect(transport);await transport.handleRequest(req,res);}
  catch{if(!res.headersSent)res.writeHead(500);res.end();}
 });
 let address:URL;
 await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
 const endpoint=listener.address();
 if(!endpoint||typeof endpoint==='string')throw new Error('Could not start workspace endpoint.');
 address=new URL('http://127.0.0.1:'+endpoint.port+route);
 return {url:address.href,dispose(){listener.close();listener.closeAllConnections();}};
}
