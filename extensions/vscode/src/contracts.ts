import type {Member5Options} from './validation/adapter';
/** Shared boundary. Adapters own agent execution, staging, writes and validation. */
export type HunkState = 'proposed' | 'accepted' | 'rejected' | 'applied';
export interface Hunk { id: string; oldStart: number; newStart: number; before: string; after: string; state: HunkState }
export interface FilePatch { id: string; path: string; original: string; proposed: string; hunks: Hunk[] }
export interface Review { id: string; revision: number; snapshotId: string; files: FilePatch[]; canUndo: boolean; applied: boolean }
export interface Evidence { id: string; uri?: string; path: string; symbol?: string; startLine?: number; endLine?: number; reason: string; characters: number; excluded?: boolean }
export interface ValidationDetails { checks:{kind:string;status:string;command:string;exitCode:number|null;durationMs:number;stdout:string;stderr:string}[]; notRun:string[]; security:string[] }
export interface Validation { details?:ValidationDetails; state: 'NOT RUN'|'FRESH'|'STALE'|'FAILED'|'CONFLICT'; snapshotId: string; command?: string; exitCode?: number; durationMs?: number; summary: string; timestamp?: string; fingerprint?: string }
export interface Selection { uri: string; languageId: string; version: number; text: string; range: { start: {line:number;character:number}; end: {line:number;character:number} } }
export interface Request { id: string; instruction: string; mode: 'chat'|'inline'; selection?: Selection; workspaceUris: string[] }
export type AgentEvent =
 | {type:'text'; delta:string}
 | {type:'progress'; message:string}
 | {type:'tool'; id:string; name:string; status:'running'|'completed'|'failed'; detail:string}
 | {type:'context'; items:Evidence[]; budget:number; used:number}
 | {type:'review'; review:Review}
 | {type:'validation'; validation:Validation}
 | {type:'error'; message:string};
export interface Services {
 label: string; demo?: boolean;
 capabilities?:{patches:boolean;validation:boolean};
 /** Engine/ledger updates after the agent turn, including disk-conflict invalidation. */
 subscribe?(listener:(event: Extract<AgentEvent,{type:'review'|'validation'}>)=>void):{dispose():void};
 agent: { run(request:Request, signal:AbortSignal): AsyncIterable<AgentEvent>; cancel(requestId:string):Promise<void> };
 patches: {
  decide(reviewId:string, revision:number, fileId:string, hunkId:string, decision:'accepted'|'rejected'):Promise<Review>;
  apply(reviewId:string, revision:number):Promise<Review>;
  undo(reviewId:string, revision:number):Promise<Review>;
  discard(reviewId:string):Promise<void>;
 };
 validation: { run(review:Review, signal:AbortSignal):Promise<Validation> };
}
/** Call from the composition root, or another extension after awaiting activate(). */
export interface LiveComponents { patches:Services["patches"]; validation?:Services["validation"]; member5?:Member5Options; subscribe?:Services["subscribe"]; cleanupRequest(requestId:string):Promise<void> }
export interface ProofPatchAPI { version:1; createValidation(options:Member5Options):Services["validation"]; connect(services:Services):{dispose():void}; connectTrueForge(components?:LiveComponents):Promise<{dispose():void}> }
export interface Message { role:'user'|'assistant'; text:string }
export interface State {
 status:'idle'|'running'|'cancelling'|'cancelled'|'review'|'error';
 capabilities?:{patches:boolean;validation:boolean};
 service:string; demo:boolean; connected:boolean; requestId?:string; busy?:string;
 messages:Message[]; activity:string[]; tools:Extract<AgentEvent,{type:'tool'}>[];
 context:Evidence[]; budget:number; used:number; review?:Review; validation?:Validation; error?:string;
}
