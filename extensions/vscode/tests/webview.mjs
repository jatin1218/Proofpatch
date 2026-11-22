// Real Chromium rendering and bridge tests, using a mock extension host.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const initial={status:'idle',service:'UI test integration',demo:false,connected:true,messages:[],activity:[],tools:[],context:[],budget:0,used:0};
const server=createServer(async(req,res)=>{
 if(req.url==='/'){
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script>window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m),getState:()=>({}),setState:()=>{}});</script><script src="/webview.js"></script></body></html>`);return;
 }
 const name=req.url==='/webview.js'?'webview.js':req.url==='/webview.css'?'webview.css':undefined;
 if(!name){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',name.endsWith('css')?'text/css':'text/javascript');res.end(await readFile(new URL('../dist/'+name,import.meta.url)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:380,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.messages.some(m=>m.type==='ready'));
 const state=s=>page.evaluate(s=>window.postMessage({type:'state',state:s},'*'),s);
 await state(initial);await page.getByLabel('Ask ProofPatch').fill('Fix @symbol greet');await page.getByRole('button',{name:'Send',exact:true}).click();
 assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='send'&&m.instruction==='Fix @symbol greet')));
 const review={id:'r',revision:3,snapshotId:'sample-snapshot-3',canUndo:false,applied:false,files:[{id:'f',path:'src/example.py',original:'print(name)',proposed:'print(name.strip())',hunks:[{id:'h',oldStart:1,newStart:1,before:'print(name)',after:'print(name.strip())',state:'proposed'}]}]};
 const rich={...initial,status:'review',review,messages:[{role:'user',text:'Handle whitespace in names'},{role:'assistant',text:'I found the output path. Review the proposed change below. <img src=x onerror="window.hacked=true">'}],context:[{id:'e',path:'src/example.py',uri:'file:///project/src/example.py',startLine:1,reason:'Directly matches the requested output behavior.',characters:120}],budget:8000,used:120,validation:{state:'STALE',snapshotId:'older-snapshot',summary:'Staged content changed. Run validation again.'}};
 await state(rich);assert.equal(await page.locator('img').count(),0);assert.ok((await page.locator('.message-text').last().textContent()).includes('<img'));
 await page.getByRole('button',{name:'Review · 1',exact:true}).click();await page.getByRole('button',{name:'Accept hunk',exact:true}).click();
 assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='decide'&&m.reviewId==='r'&&m.revision===3&&m.hunkId==='h')));
 assert.equal(await page.getByRole('button',{name:'Apply accepted',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Open diff',exact:true}).click();assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='diff'&&m.fileId==='f')));
 if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT,fullPage:true});
 await page.getByRole('button',{name:'Evidence · 1',exact:true}).click();assert.equal(await page.getByText('STALE',{exact:true}).count(),1);
 await page.getByRole('button',{name:'Run validation',exact:true}).click();assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='validate')));
 await page.getByRole('button',{name:'src/example.py:1',exact:true}).click();assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='evidence'&&m.id==='e')));
 await state({...rich,status:'running'});await page.getByRole('button',{name:'Stop',exact:true}).click();assert.ok(await page.evaluate(()=>window.messages.some(m=>m.type==='stop')));
 for(const width of [280,380,900]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,`No horizontal page overflow at ${width}px`);}
 assert.deepEqual(errors,[]);console.log('PASS: Chromium webview messaging, diff/review controls, evidence, cancellation, escaped content, and responsive widths.');
}finally{await browser.close();server.close();}
