import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { PatchEngineClient, PatchEngineServer, RpcError } from '../src';
import { lines, makeEngine, makeWorkspace } from './helpers';

async function setup(files: Record<string, string>) {
  const ws = await makeWorkspace(files);
  const engine = makeEngine(ws.root);
  const server = new PatchEngineServer(engine);
  const info = await server.start();
  const agent = await PatchEngineClient.connect(info.socketPath, info.agentToken);
  const user = await PatchEngineClient.connect(info.socketPath, info.userToken);
  return {
    ws, engine, info, agent, user,
    async close() {
      agent.close();
      user.close();
      await server.stop();
      await ws.cleanup();
    }
  };
}

const code = async (p: Promise<unknown>) => p.then(() => 'OK', (e: RpcError) => e.code);

test('roles: agent can read and propose but cannot review, apply, undo or cancel', async () => {
  const t = await setup({ 'a.txt': lines(10) });
  assert.equal(t.agent.role, 'agent');
  assert.equal(t.user.role, 'user');

  assert.equal(await t.agent.readFile('a.txt'), lines(10));
  const r = await t.agent.proposeFile({ path: 'a.txt', newContent: lines(10).replace('line 2\n', 'TWO\n'), turnId: 'T' });
  assert.ok(r.ok);

  const hunkId = (await t.agent.getChangeSet())!.files[0].hunks[0].id;
  assert.equal(await code(t.agent.setHunkDecision(hunkId, 'accepted')), 'FORBIDDEN');
  assert.equal(await code(t.agent.setAllDecisions('accepted')), 'FORBIDDEN');
  assert.equal(await code(t.agent.apply()), 'FORBIDDEN');
  assert.equal(await code(t.agent.undo()), 'FORBIDDEN');
  assert.equal(await code(t.agent.cancelTurn('T')), 'FORBIDDEN');
  assert.equal(await code(t.agent.discard()), 'FORBIDDEN');
  assert.equal(await code(t.agent.recover()), 'FORBIDDEN');
  assert.equal(await code(t.agent.materializeSnapshot()), 'FORBIDDEN');
  assert.equal(await code(t.agent.call('does.not.exist')), 'FORBIDDEN');
  assert.equal(await t.ws.read('a.txt'), lines(10), 'agent could not write anything');

  await t.user.setHunkDecision(hunkId, 'accepted');
  const applied = await t.user.apply();
  assert.ok(applied.ok);
  assert.match(await t.ws.read('a.txt'), /TWO/);
  assert.ok((await t.user.undo()).ok);
  assert.equal(await t.ws.read('a.txt'), lines(10));
  await t.close();
});

test('bad or missing token is rejected; unauthenticated calls are refused', async () => {
  const t = await setup({ 'a.txt': 'x\n' });
  await assert.rejects(() => PatchEngineClient.connect(t.info.socketPath, 'wrong'), (e: RpcError) => e.code === 'UNAUTHENTICATED');
  // Raw socket skipping hello.
  const reply = await new Promise<string>((resolve) => {
    const s = net.connect(t.info.socketPath, () => s.write(JSON.stringify({ id: 1, method: 'view.readFile', params: { path: 'a.txt' } }) + '\n'));
    s.setEncoding('utf8');
    s.once('data', (d: string) => {
      s.destroy();
      resolve(d);
    });
  });
  assert.match(reply, /UNAUTHENTICATED/);
  await t.close();
});

test('agent cannot read or propose secrets; secrets are hidden from listings and search', async () => {
  const t = await setup({ '.env': 'API_KEY=hunter2\n', 'app.py': 'KEY = "x"\n' });
  assert.equal(await code(t.agent.readFile('.env')), 'PATH_SECRET');
  assert.equal(await code(t.agent.readLines('.env', 1, 5)), 'PATH_SECRET');
  const p = await t.agent.proposeFile({ path: '.env', newContent: 'API_KEY=leak\n' });
  assert.ok(!p.ok && p.code === 'PATH_SECRET');
  assert.deepEqual((await t.agent.listFiles()).files, ['app.py']);
  assert.equal((await t.agent.search('hunter2')).matches.length, 0);
  await t.close();
});

test('path traversal over IPC is rejected with a structured error', async () => {
  const t = await setup({ 'a.txt': 'x\n' });
  assert.equal(await code(t.agent.readFile('../../etc/passwd')), 'PATH_OUTSIDE_WORKSPACE');
  await t.close();
});

test('events are pushed to clients (staged-changed carries the new fingerprint)', async () => {
  const t = await setup({ 'a.txt': 'x\n' });
  const got = new Promise<{ fingerprint: string; stagedFiles: string[] }>((resolve) => t.user.once('staged-changed', resolve));
  await t.agent.proposeFile({ path: 'a.txt', newContent: 'y\n' });
  await t.user.setAllDecisions('accepted');
  const ev = await got;
  assert.deepEqual(ev.stagedFiles, ['a.txt']);
  assert.equal(ev.fingerprint, (await t.user.fingerprint()).fingerprint);
  await t.close();
});

test('snapshot over IPC and conflict result shape', async () => {
  const t = await setup({ 'a.txt': 'x\n', 'b.txt': 'b\n' });
  await t.agent.proposeFile({ path: 'a.txt', newContent: 'y\n' });
  await t.user.setAllDecisions('accepted');
  const snap = await t.user.materializeSnapshot();
  assert.deepEqual(snap.stagedFiles, ['a.txt']);
  await t.user.disposeSnapshot(snap.dir);

  await t.ws.write('a.txt', 'edited\n');
  const r = await t.user.apply();
  assert.ok(!r.ok && r.code === 'CONFLICT' && r.conflicts?.[0].path === 'a.txt');
  await t.close();
});
