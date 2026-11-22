import {z} from 'zod';
import type {AgentEvent} from '../contracts';
const id=z.string().min(1).max(512),txt=z.string().max(200000),line=z.number().int().positive();
const hunk=z.object({id,oldStart:z.number().int().nonnegative(),newStart:z.number().int().nonnegative(),before:txt,after:txt,state:z.enum(['proposed','accepted','rejected','applied'])});
const review=z.object({id,revision:z.number().int().nonnegative(),snapshotId:id,canUndo:z.boolean(),applied:z.boolean(),files:z.array(z.object({id,path:id,original:txt,proposed:txt,hunks:z.array(hunk).max(200)})).max(100)});
const validation=z.object({state:z.enum(['NOT RUN','FRESH','STALE','FAILED','CONFLICT']),snapshotId:id,command:z.string().max(4000).optional(),exitCode:z.number().int().optional(),durationMs:z.number().nonnegative().optional(),summary:txt,timestamp:z.string().optional(),fingerprint:z.string().optional()});
const event=z.discriminatedUnion('type',[
 z.object({type:z.literal('review'),review}),z.object({type:z.literal('validation'),validation}),
 z.object({type:z.literal('context'),items:z.array(z.object({id,uri:z.string().max(4000).optional(),path:id,symbol:id.optional(),startLine:line.optional(),endLine:line.optional(),reason:txt,characters:z.number().nonnegative(),excluded:z.boolean().optional()})).max(200),budget:z.number().nonnegative(),used:z.number().nonnegative()})
]);
const envelope=z.object({proofpatch:z.object({version:z.literal(1),requestId:id,events:z.array(event).max(100)})});
/** Called only for tool.response from the selected MCP connector, never model text. */
export function evidenceEvents(content:string,requestId:string):AgentEvent[]{
 if(content.length>2_000_000)return [{type:'progress',message:'MCP evidence exceeded the 2 MB UI limit.'}];
 let raw:unknown;try{raw=JSON.parse(content);}catch{return [];}
 // Support an MCP CallToolResult with structuredContent, or a JSON text content item.
 const result=raw as {structuredContent?:unknown;content?:{type:string;text?:string}[]};
 if(result?.structuredContent)raw=result.structuredContent;
 else if(Array.isArray(result?.content)){
  const text=result.content.find(c=>c.type==='text'&&c.text)?.text;
  if(text){try{raw=JSON.parse(text);}catch{return [];}}
 }
 const parsed=envelope.safeParse(raw);
 if(!parsed.success)return (raw as {proofpatch?:unknown})?.proofpatch?[{type:'progress',message:'MCP returned an invalid ProofPatch evidence envelope; ignored.'}]:[];
 if(parsed.data.proofpatch.requestId!==requestId)return [];
 return parsed.data.proofpatch.events;
}
