import { ValidationSession, buildSnapshotManifest, type CheckSpec, type SessionOptions, type StagedSnapshot, type ValidateOptions, type ValidationOutcome } from '../../../../core/validation/src/index';
import type { Review, Services, Validation } from '../contracts';

/** Supplied by Member 4, never reconstructed from the review's proposed diff. */
export interface ReviewSnapshot {
 reviewId:string; revision:number; snapshotId:string;
 snapshot:StagedSnapshot;
 /** False for unsupported binary files, modes, symlinks, renames or incomplete input. */
 complete:boolean;
 limitations?:string[];
 conflictingPaths?:string[];
}
export interface Member5Options extends SessionOptions {
 getSnapshot(review:Review):Promise<ReviewSnapshot>;
 checks:readonly CheckSpec[];
 security?:ValidateOptions['security'];
}
export type ValidationApproval=(checks:readonly CheckSpec[],signal:AbortSignal)=>Promise<boolean>;
class SnapshotMoved extends Error {}

export function presentOutcome(outcome:ValidationOutcome,review:Review):Validation {
 const {report,runs,security}=outcome;
 const commands=runs.map(r=>[r.command.executable,...r.command.args].join(' '));
 return {
  state:report.overall==='NOT_RUN'?'NOT RUN':report.overall,
  snapshotId:review.snapshotId,fingerprint:report.snapshotFingerprint,
  command:commands.join(' ; ')||undefined,
  exitCode:report.overall==='FRESH'?0:runs.find(r=>r.status!=='passed')?.exitCode??undefined,
  durationMs:runs.reduce((sum,r)=>sum+r.durationMs,0),timestamp:runs.at(-1)?.finishedAt,
  summary:`${runs.filter(r=>r.status==='passed').length}/${runs.length} checks passed. ${report.checksNotRun.length} checks not run. Security findings are reported separately.`,
  details:{checks:runs.map(r=>({kind:r.command.kind,status:r.status,command:[r.command.executable,...r.command.args].join(' '),exitCode:r.exitCode,durationMs:r.durationMs,stdout:r.outputSummary.stdoutTail,stderr:r.outputSummary.stderrTail})),
   notRun:report.checksNotRun.map(c=>`${c.kind}: ${c.reason}${c.detail?` — ${c.detail}`:''}`),
   security:[security.secrets?`Secret scan: ${security.secrets.status}; ${security.secrets.findings.length} finding(s).`:'Secret scan: not run.',security.semgrep?`Semgrep: ${security.semgrep.outcome}.`:'Semgrep: not run.']}
 };
}

/** Approval is supplied by the host, never by agent text or an MCP response. */
export function createMember5Validation(options:Member5Options,approve:ValidationApproval):Services['validation'] {
 const session=new ValidationSession(options);
 let running=false;
 return {async run(review,signal){
  if(running)throw new Error('Validation is already running.');
  running=true;
  const notRun=(summary:string):Validation=>({state:'NOT RUN',snapshotId:review.snapshotId,summary});
  try{
   const read=async()=>{
    const value=await options.getSnapshot(review);
    if(value.reviewId!==review.id||value.revision!==review.revision||value.snapshotId!==review.snapshotId)throw new SnapshotMoved();
    return value;
   };
   const initial=await read();
   if(initial.conflictingPaths?.length)return {state:'CONFLICT',snapshotId:review.snapshotId,summary:`Disk conflicts: ${initial.conflictingPaths.join(', ')}`};
   if(!initial.complete)return notRun(`Snapshot is incomplete. ${initial.limitations?.join('; ')??'Member 4 must provide all validation inputs.'}`);
   if(!options.checks.length)return notRun('No validation commands configured. No tests ran.');
   if(signal.aborted||!await approve(options.checks,signal)||signal.aborted)return notRun('Validation cancelled before execution.');
   const expected=buildSnapshotManifest(initial.snapshot.files).fingerprint;
   const source={async getStagedSnapshot(){
    const value=await read();
    if(value.conflictingPaths?.length)session.reportConflict({conflictingPaths:value.conflictingPaths});
    if(!value.complete||value.conflictingPaths?.length)throw new SnapshotMoved();
    return value.snapshot;
   }};
   session.clearConflict();
   if(buildSnapshotManifest((await source.getStagedSnapshot()).files).fingerprint!==expected)throw new SnapshotMoved();
   const outcome=await session.validate(source,options.checks,{signal,security:options.security});
   // Include changes during security scanning, after the core's last check.
   const latest=await read();
   const result=presentOutcome(outcome,review);
   if(latest.conflictingPaths?.length)return {...result,state:'CONFLICT',summary:'Disk conflicts were reported during validation.'};
   if(!latest.complete||buildSnapshotManifest(latest.snapshot.files).fingerprint!==expected)return {...result,state:'STALE',summary:'Staged content changed during validation. Run checks again.'};
   if(signal.aborted)return {...result,state:'NOT RUN',summary:'Validation was cancelled. Results are incomplete.'};
   return result;
  }catch(error){
   if(error instanceof SnapshotMoved)return {state:'STALE',snapshotId:review.snapshotId,summary:'The staged snapshot changed. Refresh the review and validate again.'};
   throw error;
  }finally{running=false;}
 }};
}
