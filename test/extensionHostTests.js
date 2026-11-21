const assert = require('node:assert/strict');
const vscode = require('vscode');

async function waitFor(action, description) {
  const limit = Date.now() + 15000;
  while (Date.now() < limit) {
    if (await action()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function run() {
  const extension = vscode.extensions.getExtension('local.renpy-sound-picker');
  assert.ok(extension, 'standalone extension is installed');
  const api = await extension.activate();
  const first = vscode.workspace.workspaceFolders[0].uri;
  const second = vscode.workspace.workspaceFolders[1].uri;
  const uri = vscode.Uri.joinPath(first, 'game', 'script.rpy');
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  await waitFor(() => vscode.languages.getDiagnostics(uri).filter((item) => item.source === 'Ren\'Py Sound Picker').length === 2, 'missing sound diagnostics');
  const warnings = vscode.languages.getDiagnostics(uri).filter((item) => item.source === 'Ren\'Py Sound Picker');
  assert.deepEqual(warnings.map((item) => item.range.start.line), [3, 4]);
  const results = await api.scanWorkspace();
  assert.equal(results.filter((item) => item.status === 'missing').length, 4, 'scanner and diagnostics agree across isolated projects');
  assert.equal(results.filter((item) => item.status === 'unverifiable').length, 1, 'runtime expression is separately reported; expression statement ignored');
  assert.ok(!results.some((item) => item.uri.path.includes('/renpy/')));
  const bomResult = results.find((item) => item.filename === 'bom-missing.ogg');
  assert.equal(bomResult.line, 1, 'scan line numbers ignore the byte-order mark');
  const bomDocument = await vscode.workspace.openTextDocument(bomResult.uri);
  assert.equal(bomDocument.getText(new vscode.Range(
    bomDocument.positionAt(bomResult.reference.start), bomDocument.positionAt(bomResult.reference.end)
  )), '"bom-missing.ogg"', 'scan offsets align with editor documents in BOM files');

  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, new vscode.Position(1, 17));
  const markdown = hovers.flatMap((hover) => hover.contents).map((item) => item.value || '').join('\n');
  assert.match(markdown, /Play sound/);
  assert.match(markdown, /0:01/);
  assert.match(markdown, /tone\.wav/);
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(1, 4, 1, 4));
  assert.ok(actions.some((action) => action.command?.command === 'renpySoundPicker.insertSoundFromProject'));

  const aliasUri = vscode.Uri.joinPath(first, 'game', 'aliases.rpy');
  const aliasDocument = await vscode.workspace.openTextDocument(aliasUri);
  const aliasEdit = new vscode.WorkspaceEdit();
  aliasEdit.replace(aliasUri, new vscode.Range(aliasDocument.positionAt(0), aliasDocument.positionAt(aliasDocument.getText().length)),
    'define audio.theme = "missing-theme.ogg"\n');
  assert.equal(await vscode.workspace.applyEdit(aliasEdit), true);
  await waitFor(() => vscode.languages.getDiagnostics(uri).filter((item) => item.source === 'Ren\'Py Sound Picker').length === 3, 'unsaved alias dependency update');
  const dirtyResults = await api.scanWorkspace();
  assert.ok(dirtyResults.some((item) => item.uri.toString() === uri.toString() && item.filename === 'missing-theme.ogg'));

  const audioUri = vscode.Uri.joinPath(first, 'game', 'audio', 'tone.wav');
  const audio = await vscode.workspace.fs.readFile(audioUri);
  await vscode.workspace.fs.delete(audioUri);
  await waitFor(() => vscode.languages.getDiagnostics(uri).filter((item) => item.source === 'Ren\'Py Sound Picker').length === 4, 'deleted audio invalidation');
  await vscode.workspace.fs.writeFile(audioUri, audio);
  await waitFor(() => vscode.languages.getDiagnostics(uri).filter((item) => item.source === 'Ren\'Py Sound Picker').length === 3, 'restored audio invalidation');

  const configuration = vscode.workspace.getConfiguration('renpySoundPicker', uri);
  await configuration.update('markMissingSounds', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await waitFor(() => !vscode.languages.getDiagnostics(uri).some((item) => item.source === 'Ren\'Py Sound Picker'), 'disabled warning configuration');
  assert.ok((await api.scanWorkspace()).some((item) => item.status === 'missing'), 'manual scan remains available with warnings disabled');
  await configuration.update('markMissingSounds', true, vscode.ConfigurationTarget.WorkspaceFolder);

  const secondDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(second, 'script.rpy'));
  assert.equal((await api.resultsFor(secondDocument))[0].status, 'missing', 'direct game-root workspace is isolated');
  const cancelled = await api.scanWorkspace({ isCancellationRequested: true });
  assert.equal(cancelled, null);
  if (process.env.SOUND_TEST_UI !== '1') {
    console.log('VS Code minimum-version integration checks passed.');
    return;
  }
  const { chromium } = require('playwright-core');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.SOUND_TEST_CDP_PORT}`, { noDefaults: true });
  try {
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(1, 17, 1, 17);
    await vscode.commands.executeCommand('renpySoundPicker.insertSoundFromProject');
    let frame;
    await waitFor(async () => {
      for (const page of browser.contexts().flatMap((context) => context.pages())) {
        for (const candidate of page.frames()) {
          if (await candidate.locator('body[data-picker="true"] #grid .card').count()) { frame = candidate; return true; }
        }
      }
      return false;
    }, 'picker webview ready handshake');
    assert.equal(await frame.locator('.card').count(), 2);
    await frame.locator('#search').fill('tone');
    assert.equal(await frame.locator('.card').count(), 1);
    await frame.locator('#searchMode').selectOption('crossPartial');
    await frame.locator('#search').fill('wav tone');
    assert.equal(await frame.locator('.card').count(), 1);
    const beforePreview = document.getText();
    await frame.getByRole('button', { name: 'Play audio/tone.wav', exact: true }).click();
    await waitFor(() => frame.locator('#audio').evaluate((audio) => audio.duration === 1.25 && audio.currentTime > 0), 'real WAV playback');
    assert.equal(document.getText(), beforePreview, 'preview never inserts');
    assert.match(await frame.locator('#metadata').textContent(), /0:01/);
    await frame.locator('#audio').evaluate((audio) => { audio.currentTime = 0.25; audio.volume = 0.25; });
    await frame.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.equal(await frame.locator('#audio').evaluate((audio) => audio.paused && audio.currentTime === 0), true);
    await frame.getByRole('button', { name: 'Insert audio/tone.wav', exact: true }).click();
    await waitFor(() => document.lineAt(1).text === '    play music "audio/tone.wav" fadein 1.0', 'insertion after webview focus');
    assert.equal(await frame.locator('#search').count(), 1, 'picker stays open');

    await frame.locator('#search').fill('corrupt');
    await frame.getByRole('button', { name: 'Play audio/corrupt.wav', exact: true }).click();
    await waitFor(async () => /could not|Cannot play|unavailable/.test(await frame.locator('#playerError').textContent()), 'visible corrupt audio error');
    assert.equal(await frame.locator('audio').count(), 1, 'only one active audio player');
    await frame.getByRole('button', { name: 'Insert audio/corrupt.wav', exact: true }).click();
    await waitFor(() => document.lineAt(1).text.includes('"audio/corrupt.wav"'), 'insertion independent of playback support');

    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
    editor.selection = new vscode.Selection(2, 5, 2, 5);
    await frame.getByRole('button', { name: 'Insert audio/corrupt.wav', exact: true }).click();
    await waitFor(async () => /playlist item/.test(await frame.locator('#actionError').textContent()), 'ambiguous playlist target rejected');
    assert.match(document.lineAt(2).text, /"audio\/tone.wav"/);

    await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(7, 6, 7, 6);
    await frame.locator('#channel').selectOption('music');
    await frame.getByRole('button', { name: 'Insert audio/corrupt.wav', exact: true }).click();
    await waitFor(() => document.getText().endsWith('    return\n    play music "audio/corrupt.wav"'), 'new indented music statement');

    const change = new vscode.WorkspaceEdit();
    change.insert(uri, new vscode.Position(0, 0), '# changed while the picker has focus\n');
    assert.equal(await vscode.workspace.applyEdit(change), true);
    const afterChange = document.getText();
    await frame.getByRole('button', { name: 'Insert audio/corrupt.wav', exact: true }).click();
    await waitFor(async () => /document changed/.test(await frame.locator('#actionError').textContent()), 'stale insertion target rejected');
    assert.equal(document.getText(), afterChange);

    await vscode.commands.executeCommand('renpySoundPicker.playSound', {
      uri: uri.toString(), offset: document.getText().indexOf('"audio/tone.wav"', document.getText().indexOf('queue')),
      version: document.version
    });
    let playerFrame;
    await waitFor(async () => {
      for (const page of browser.contexts().flatMap((context) => context.pages())) {
        for (const candidate of page.frames()) {
          if (await candidate.locator('body[data-picker="false"] #audio').count()) { playerFrame = candidate; return true; }
        }
      }
      return false;
    }, 'hover-command player panel');
    await waitFor(() => playerFrame.locator('#audio').evaluate((audio) => audio.duration === 1.25 && audio.currentTime > 0), 'hover command ready handshake playback');

    const overview = vscode.commands.executeCommand('renpySoundPicker.rescanMissingSounds');
    const workbench = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('workbench'));
    assert.ok(workbench, 'test workbench is accessible');
    const quickInput = workbench.locator('.quick-input-widget input').first();
    await quickInput.waitFor({ state: 'visible' });
    await quickInput.fill('missing-voice.wav');
    await waitFor(() => workbench.locator('.quick-input-list .monaco-list-row').count().then((count) => count === 1), 'filtered missing-sound overview');
    await quickInput.press('Enter');
    await overview;
    assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri.toString());
    assert.equal(document.lineAt(vscode.window.activeTextEditor.selection.start.line).text.trim(), 'voice "missing-voice.wav"', 'overview navigates to the actual missing reference');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => playerFrame.isDetached(), 'closing the panel disposes its player');
    console.log('Extension-host and real webview checks passed: activation, hover, actions, diagnostics, scanning, dirty aliases, file invalidation, settings, project isolation, search, playback/stop, focused insertion, ambiguous playlists, and corrupt audio.');
  } finally {
    await browser.close();
  }
}

module.exports = { run };
