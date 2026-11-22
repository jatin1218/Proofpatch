/**
 * Demo: Forge-a-thon Task A flow through the Safe Patch Engine, with no AI involved.
 *
 * NOTE: this uses a small stand-in for Flask's src/flask/helpers.py (get_debug_flag), NOT the pinned
 * Flask 3.1.3 file. Run the real Task A against the pinned checkout for the submission demo.
 *
 *   propose -> review per hunk -> staged overlay -> validate staged snapshot -> apply -> undo
 */
import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PatchEngine } from '../src';

const HELPERS = `import os


def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no"})


def unrelated() -> int:
    return 1
`;

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pp-demo-'));
  const undoDir = root + '-undo';
  await fsp.mkdir(path.join(root, 'src/flask'), { recursive: true });
  const file = path.join(root, 'src/flask/helpers.py');
  await fsp.writeFile(file, HELPERS);

  const engine = new PatchEngine({ workspaceRoot: root, undoDir });
  engine.on('staged-changed', (e) => console.log(`  [event] staged-changed -> ${e.fingerprint.slice(0, 12)}…  files=${e.stagedFiles}`));

  console.log('1. Agent proposes an edit (MCP tool: patch.proposeEdits). Disk is not touched.');
  const res = await engine.proposeEdits({
    path: 'src/flask/helpers.py',
    turnId: 'turn-1',
    description: 'get_debug_flag: treat off and n as false',
    edits: [
      { oldText: 'val.lower() not in {"0", "false", "no"}', newText: 'val.lower() not in {"0", "false", "no", "off", "n"}' },
      { oldText: 'The default is ``False``.', newText: 'The default is ``False``. The values ``0``, ``false``, ``no``,\n    ``off`` and ``n`` (case-insensitive) are treated as false.' }
    ]
  });
  console.log('  ', JSON.stringify(res));
  console.log('   on disk still has "off"?', (await fsp.readFile(file, 'utf8')).includes('"off"'));

  console.log('\n2. Developer reviews hunk by hunk:');
  const cs = engine.getChangeSet()!;
  for (const f of cs.files) for (const h of f.hunks) console.log(`   ${f.path} ${h.header} (+${h.added} -${h.removed}) [${h.state}]`);
  await engine.setAllDecisions('accepted');

  console.log('\n3. Staged view (what search/read/tests must see):');
  console.log('   view sees "off":', (await engine.view.readFile('src/flask/helpers.py')).includes('"off"'));
  console.log('   disk  sees "off":', (await fsp.readFile(file, 'utf8')).includes('"off"'));

  console.log('\n4. Validate the staged snapshot (exact accepted hunks), not the checkout:');
  const snap = await engine.materializeSnapshot();
  try {
    const code = [
      'import sys, os; sys.path.insert(0, os.path.join(sys.argv[1], "src", "flask"))',
      'import helpers',
      'assert helpers.__file__.startswith(sys.argv[1]), helpers.__file__',
      'for v in ("off", "OFF", "n", "N", "0", "false", "no"):',
      '    os.environ["FLASK_DEBUG"] = v',
      '    assert helpers.get_debug_flag() is False, v',
      'os.environ["FLASK_DEBUG"] = "1"; assert helpers.get_debug_flag() is True',
      'print(False)'
    ].join('\n');
    const out = execFileSync('python3', ['-c', code, snap.dir], { encoding: 'utf8' }).trim();
    console.log(`   python check printed: ${out}   (snapshot fingerprint ${snap.fingerprint.slice(0, 12)}…)`);
  } catch (e) {
    console.log('   (python3 unavailable or check failed:', (e as Error).message.split('\n')[0], ')');
  } finally {
    await engine.disposeSnapshot(snap.dir);
  }

  console.log('\n5. Apply (explicit user action):');
  const applied = await engine.apply();
  console.log('  ', JSON.stringify(applied));
  console.log('   disk now has "off":', (await fsp.readFile(file, 'utf8')).includes('"off"'));

  console.log('\n6. Undo:');
  console.log('  ', JSON.stringify(await engine.undo()));
  console.log('   disk restored exactly:', (await fsp.readFile(file, 'utf8')) === HELPERS);

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(undoDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
