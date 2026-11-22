import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {State} from '../src/contracts';
import './style.css';
declare function acquireVsCodeApi():{postMessage(message:unknown):void;getState():{draft?:string}|undefined;setState(state:unknown):void};
const api=acquireVsCodeApi();const send=(message:unknown)=>api.postMessage(message);
function App(){
 const [state,setState]=useState<State>();const [draft,setDraft]=useState(()=>api.getState()?.draft??'');const [tab,setTab]=useState<'chat'|'review'|'evidence'>('chat');
 useEffect(()=>{const handler=(e:MessageEvent)=>{if(e.data?.type==='state')setState(e.data.state);};window.addEventListener('message',handler);send({type:'ready'});return()=>window.removeEventListener('message',handler);},[]);
 useEffect(()=>{api.setState({draft});},[draft]);
 if(!state)return <main><p role="status">Connecting to ProofPatch…</p></main>;
 const busy=!!state.busy||['running','cancelling'].includes(state.status);
 const review=state.review;const hunks=review?.files.flatMap(f=>f.hunks)??[];
 const accepted=hunks.filter(h=>h.state==='accepted').length;
 const stopEnabled=state.status==='running'||state.busy==='Validating';
 const submit=()=>{if(!draft.trim()||busy||!state.connected)return;send({type:'send',instruction:draft.trim()});setDraft('');};
 return <main>
  <header><div className="wordmark"><span className="shield">✓</span><div><strong>ProofPatch</strong><small>Understand. Review. Verify.</small></div></div><span className={'status '+state.status} role="status">{state.busy??state.status}</span></header>
  <div className="connection"><span className="dot"/>{state.service}</div>
  {state.connected&&!state.demo&&state.capabilities?.patches===false&&<p className="notice">LIVE AGENT · Patch application requires Member 4. Validation uses Member 5 when a Member 4 staged snapshot is connected.</p>}
  {state.demo&&<p className="notice">DEMO MODE · Simulated agent and review. No files are changed and no tests are run.</p>}
  {!state.connected&&<section className="welcome"><h1>Every change deserves evidence.</h1><p>Ask about your code, inspect proposed changes, and see exactly what was checked.</p><div className="actions"><button onClick={()=>send({type:'connect'})}>Connect TrueForge</button><button className="secondary" onClick={()=>send({type:'demo'})}>Try the interactive demo</button></div><p className="muted">Start local TrueForge and configure Google / Gemini in its Settings → Models, then connect.</p></section>}
  <nav aria-label="ProofPatch views">{(['chat','review','evidence'] as const).map(t=><button key={t} aria-pressed={tab===t} className={tab===t?'selected':''} onClick={()=>setTab(t)}>{t==='chat'?'Chat':t==='review'?`Review${hunks.length?` · ${hunks.length}`:''}`:`Evidence${state.context.length?` · ${state.context.length}`:''}`}</button>)}</nav>
  {state.error&&<div className="error" role="alert"><strong>Unable to complete action</strong><p>{state.error}</p></div>}
  {tab==='chat'&&<>
   <section aria-label="Conversation" className="conversation">{!state.messages.length&&state.connected&&<div className="empty"><h2>What would you like to change?</h2><p>Describe a task or select code in the editor and choose <strong>ProofPatch: Edit Selection</strong>.</p><p className="muted">You can include @file or @symbol references. Your context integration resolves them.</p></div>}{state.messages.map((m,i)=><article className={'message '+m.role} key={i}><div className="eyebrow">{m.role==='user'?'You':'ProofPatch'}</div><div className="message-text">{m.text||(state.status==='running'?'Working…':'No response text.')}</div></article>)}</section>
   {(state.activity.length>0||state.tools.length>0)&&<details open className="activity"><summary>Agent activity · {state.tools.length} tools</summary><ul>{state.activity.map((a,i)=><li key={i}>{a}</li>)}{state.tools.map(t=><li key={t.id}><strong>{t.name}</strong> <span className="muted">{t.status}</span><div>{t.detail}</div></li>)}</ul></details>}
   {review&&<button className="wide secondary" onClick={()=>setTab('review')}>Review {hunks.length} proposed hunk(s) →</button>}
  </>}
  {tab==='review'&&<section>
   <div className="section-heading"><h2>Proposed changes</h2><span className="muted">{accepted} accepted</span></div>
   <p className="muted">Accept stages a hunk. Only Apply can write changes through the patch engine.</p>
   {!review&&<p className="empty">Proposals will appear here after an agent request.</p>}
   {review?.files.map(f=><article className="file" key={f.id}><div className="file-header"><strong>{f.path}</strong><button className="secondary" onClick={()=>send({type:'diff',fileId:f.id})}>Open diff</button></div>{f.hunks.map((h,i)=><section className="hunk" key={h.id} aria-label={`Hunk ${i+1} in ${f.path}`}><div className="hunk-heading">Hunk {i+1} · −{h.oldStart} / +{h.newStart}<span className={'badge '+h.state}>{h.state}</span></div><pre className="removed" aria-label="Removed code">{h.before.split('\n').map(l=>'- '+l).join('\n')}</pre><pre className="added" aria-label="Added code">{h.after.split('\n').map(l=>'+ '+l).join('\n')}</pre><div className="actions"><button disabled={busy||state.capabilities?.patches===false||review.applied||h.state==='accepted'} onClick={()=>send({type:'decide',reviewId:review.id,revision:review.revision,fileId:f.id,hunkId:h.id,decision:'accepted'})}>Accept hunk</button><button className="secondary" disabled={busy||state.capabilities?.patches===false||review.applied||h.state==='rejected'} onClick={()=>send({type:'decide',reviewId:review.id,revision:review.revision,fileId:f.id,hunkId:h.id,decision:'rejected'})}>Reject hunk</button></div></section>)}</article>)}
   {review&&<><div className="actions sticky"><button disabled={busy||state.capabilities?.patches===false||!accepted||review.applied||hunks.some(h=>h.state==='proposed')||state.validation?.state==='CONFLICT'} onClick={()=>send({type:'apply'})}>{state.demo?'Simulate Apply':'Apply accepted'}</button><button className="secondary" disabled={busy||state.capabilities?.patches===false||!review.canUndo} onClick={()=>send({type:'undo'})}>Undo apply</button></div><p className="muted">Snapshot <code>{review.snapshotId}</code> · revision {review.revision}</p></>}
  </section>}
  {tab==='evidence'&&<section>
   <div className="section-heading"><h2>Validation ledger</h2><span className={'badge '+(state.validation?.state??'')}>{state.validation?.state??'NOT RUN'}</span></div>
   <p>{state.validation?.summary??'No validation evidence is available for this request.'}</p>
   {state.validation&&<dl><dt>Snapshot</dt><dd><code>{state.validation.snapshotId}</code></dd>{state.validation.command&&<><dt>Command</dt><dd><code>{state.validation.command}</code></dd><dt>Exit code</dt><dd>{state.validation.exitCode??'Not reported'}</dd></>}{state.validation.durationMs!==undefined&&<><dt>Duration</dt><dd>{state.validation.durationMs} ms</dd></>}{state.validation.fingerprint&&<><dt>Fingerprint</dt><dd><code>{state.validation.fingerprint}</code></dd></>}{state.validation.timestamp&&<><dt>Checked</dt><dd>{state.validation.timestamp}</dd></>}</dl>}
   {state.validation?.details&&<div>{state.validation.details.checks.map((check,i)=><details key={i}><summary>{check.kind}: {check.status} · {check.durationMs} ms</summary><code>{check.command}</code><p>Exit code: {check.exitCode??'none'}</p><pre>{check.stdout}</pre><pre>{check.stderr}</pre></details>)}<h3>Checks not run</h3>{state.validation.details.notRun.map((text,i)=><p key={i}>{text}</p>)}<h3>Security</h3>{state.validation.details.security.map((text,i)=><p key={i}>{text}</p>)}</div>}
   <button disabled={busy||!review||state.capabilities?.validation===false} onClick={()=>send({type:'validate'})}>Run validation</button>
   <p className="muted">Passing checks describe the recorded snapshot and do not guarantee correctness or security.</p>
   <hr/><h2>Context evidence</h2><p className="muted">{state.used.toLocaleString()} / {state.budget.toLocaleString()} characters · reported by context integration</p>
   {!state.context.length&&<p>No context evidence reported yet.</p>}
   {state.context.map(e=><article className="evidence" key={e.id}><button className="source" disabled={!e.uri} onClick={()=>send({type:'evidence',id:e.id})}>{e.path}{e.startLine?`:${e.startLine}${e.endLine?`–${e.endLine}`:''}`:''}</button>{e.symbol&&<code>{e.symbol}</code>}<p>{e.reason}</p><small>{e.excluded?'Excluded':'Included'} · {e.characters} characters</small></article>)}
  </section>}
  <footer>{state.demo&&<button className="secondary wide" disabled={busy} onClick={()=>send({type:'connect'})}>Connect real TrueForge agent</button>}<label htmlFor="instruction">Ask ProofPatch</label><textarea id="instruction" value={draft} maxLength={32000} placeholder="Explain this code or describe a change…" onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();submit();}}}/><div className="actions"><button disabled={busy||!draft.trim()||!state.connected} onClick={submit}>Send</button><button className="secondary" disabled={busy||!state.connected} onClick={()=>send({type:'inline'})}>Edit selection</button><button className="stop" disabled={!stopEnabled} onClick={()=>send({type:'stop'})}>Stop</button></div><small className="muted">Ctrl / Cmd + Enter to send · Review before Apply</small></footer>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
