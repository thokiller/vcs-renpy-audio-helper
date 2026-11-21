const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXCLUDE = '**/{renpy,node_modules,.git,.vscode-test,cache,__pycache__,saves}/**';

async function timed(label, action) {
  const started = Date.now();
  const result = await action();
  console.log(`[probe] ${label}: ${Date.now() - started} ms`);
  return result;
}

async function run() {
  const extension = vscode.extensions.getExtension('local.renpy-sound-picker');
  assert.ok(extension, 'extension present');
  const api = await timed('activate', () => extension.activate());

  const uris = await vscode.workspace.findFiles('**/*.{rpy,rpym}', EXCLUDE);
  console.log(`[probe] ${uris.length} scripts in workspace`);

  let target;
  let targetDocument;
  for (const uri of uris) {
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').replace(/^\uFEFF/, '');
    const match = text.match(/^[ \t]*(?:play|queue)[ \t]+\w+[ \t]+(["\w])/m);
    if (match) { target = { uri, offset: match.index + match[0].length - 1 }; break; }
  }
  if (target) {
    targetDocument = await vscode.workspace.openTextDocument(target.uri);
    const position = targetDocument.positionAt(target.offset);
    console.log(`[probe] hover target ${vscode.workspace.asRelativePath(target.uri)}:${position.line + 1}`);
    for (const label of ['hover (cold index)', 'hover (warm)']) {
      const hovers = await timed(label, () =>
        vscode.commands.executeCommand('vscode.executeHoverProvider', target.uri, position));
      console.log(`[probe]   ${hovers.length} hover(s), ${hovers.flatMap((h) => h.contents).map((c) => (c.value || '').length).reduce((a, b) => a + b, 0)} chars`);
    }
  } else console.log('[probe] no play/queue statement found to hover');

  const results = await timed('full scan (cold)', () => api.scanWorkspace());
  const missing = results.filter((item) => item.status === 'missing');
  const unverifiable = results.filter((item) => item.status === 'unverifiable');
  console.log(`[probe] scan results: ${missing.length} missing, ${unverifiable.length} unverifiable`);
  for (const item of missing.slice(0, 12)) {
    console.log(`[probe]   missing ${item.filename} at ${vscode.workspace.asRelativePath(item.uri)}:${item.line + 1}`);
  }
  await timed('full scan (warm)', () => api.scanWorkspace());

  // Idle to catch runaway re-index loops, then confirm hovers stay fast.
  await new Promise((resolve) => setTimeout(resolve, 10000));
  if (target) {
    await timed('hover after 10 s idle', () =>
      vscode.commands.executeCommand('vscode.executeHoverProvider', target.uri, targetDocument.positionAt(target.offset)));
  }
  console.log('[probe] completed without hangs');
}

module.exports = { run };
