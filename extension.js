const path = require('path');
const crypto = require('crypto');
const vscode = require('vscode');
const { parseAudio, referencesOf, referenceAt, insertionEdit } = require('./audioReferences');
const { AUDIO_EXTENSIONS, createIndex, resolveAudio } = require('./audioIndex');
const { createMetadataCache, durationLabel } = require('./audioMetadata');

const SELECTORS = [{ scheme: 'file', pattern: '**/*.rpy' }, { scheme: 'file', pattern: '**/*.rpym' }];
const EXCLUDE = '**/{renpy,node_modules,.git,.vscode-test,cache,__pycache__,saves}/**';
const EXCLUDED_PATH = /(?:^|\/)(?:renpy|node_modules|\.git|\.vscode-test|cache|__pycache__|saves)\//;
const SCAN_CACHE_MS = 5 * 60 * 1000;

function isSupported(document) {
  return document.uri.scheme === 'file' && /\.(rpy|rpym)$/i.test(document.uri.path) && !EXCLUDED_PATH.test(document.uri.path);
}

function rangeOf(document, reference) {
  return new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end));
}

function relativeTo(root, uri) {
  return path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
}

function positionOf(text, offset) {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', offset);
  return {
    line: (before.match(/\n/g) || []).length,
    character: offset - lineStart,
    lineText: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, '')
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Ren\'Py Sound Picker');
  const diagnostics = vscode.languages.createDiagnosticCollection('renpySoundPicker');
  const metadata = createMetadataCache();
  const snapshots = new Map();
  const fileIndexes = new Map();
  const definitionCache = new Map();
  const editedUris = new Set();
  const reportedMetadataErrors = new Set();
  let generation = 0;
  let timer;
  let scanCache;
  let panel;
  let disposed = false;
  let lastTarget;
  let panelEntries = new Map();
  let panelRoot;
  let panelRequest = 0;
  let playbackRequest = 0;
  let panelDisposables = [];
  let pendingPlay;
  let panelLoaded = false;

  const reportError = (operation, error) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`${operation}: ${error instanceof Error ? error.stack : message}`);
    void vscode.window.showErrorMessage(`Ren'Py Sound Picker: ${operation}: ${message}`);
  };
  const guarded = (operation, action) => async (...args) => {
    try { return await action(...args); }
    catch (error) { reportError(operation, error); }
  };

  async function projectRoot(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) throw new Error('Open the Ren\'Py project as a workspace folder first.');
    const relative = relativeTo(folder.uri, uri);
    const components = relative.split('/');
    const gamePosition = components.lastIndexOf('game', components.length - 2);
    if (gamePosition !== -1) return vscode.Uri.joinPath(folder.uri, ...components.slice(0, gamePosition + 1));
    if (path.basename(folder.uri.fsPath).toLowerCase() === 'game') return folder.uri;
    const game = vscode.Uri.joinPath(folder.uri, 'game');
    try {
      const stat = await vscode.workspace.fs.stat(game);
      if (stat.type & vscode.FileType.Directory) return game;
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error;
    }
    return folder.uri;
  }

  function cachedBuild(map, key, build) {
    if (!map.has(key)) {
      const promise = build();
      // A transient failure must not poison the cache for every later request.
      promise.catch(() => { if (map.get(key) === promise) map.delete(key); });
      map.set(key, promise);
    }
    return map.get(key);
  }

  async function buildFileIndex(root) {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE);
    const entries = [];
    const scripts = [];
    let hasArchives = false;
    for (const uri of uris) {
      if (path.extname(uri.fsPath).toLowerCase() === '.rpa') hasArchives = true;
      entries.push({ uri, relativePath: relativeTo(root, uri), name: path.basename(uri.fsPath) });
      if (isSupported({ uri })) scripts.push(uri);
    }
    return { entries, scripts, hasArchives };
  }

  function openDocumentFor(uri) {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
  }

  async function textFor(uri) {
    const open = openDocumentFor(uri);
    if (open) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri);
    // TextDocument offsets never include a byte-order mark; keep both representations aligned.
    return Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '');
  }

  async function definitionsFor(uri) {
    const cacheKey = uri.toString();
    const open = openDocumentFor(uri);
    let contentKey;
    if (open) contentKey = `v${open.version}`;
    else {
      const stat = await vscode.workspace.fs.stat(uri);
      contentKey = `m${stat.mtime}:${stat.size}`;
    }
    const cached = definitionCache.get(cacheKey);
    if (cached?.contentKey === contentKey) return cached.definitions;
    const definitions = parseAudio(await textFor(uri)).filter((statement) => statement.kind === 'define');
    definitionCache.set(cacheKey, { contentKey, definitions });
    return definitions;
  }

  async function buildSnapshot(root) {
    const files = await cachedBuild(fileIndexes, root.toString(), () => buildFileIndex(root));
    const definitions = (await Promise.all(files.scripts.map((uri) => definitionsFor(uri)))).flat();
    // New unsaved documents may not yet be returned by findFiles.
    for (const document of vscode.workspace.textDocuments) {
      const relative = relativeTo(root, document.uri);
      if (isSupported(document) && document.isDirty && relative !== '..' && !relative.startsWith('../') &&
          !files.scripts.some((uri) => uri.toString() === document.uri.toString())) {
        definitions.push(...parseAudio(document.getText()).filter((statement) => statement.kind === 'define'));
      }
    }
    const directories = vscode.workspace.getConfiguration('renpySoundPicker', root).get('audioDirectories', ['audio']);
    return { root, scripts: files.scripts, index: createIndex(files.entries, definitions, directories, files.hasArchives) };
  }

  async function currentSnapshot(uri) {
    return currentRootSnapshot(await projectRoot(uri));
  }

  async function currentRootSnapshot(root) {
    let snapshot;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (disposed) throw new Error('The extension has been disposed.');
      const version = generation;
      snapshot = await cachedBuild(snapshots, root.toString(), () => buildSnapshot(root));
      if (version === generation) return snapshot;
    }
    // Files are changing continuously; a snapshot from moments ago is still usable.
    return snapshot;
  }

  async function resultsFor(document) {
    const { index } = await currentSnapshot(document.uri);
    return parseAudio(document.getText()).flatMap((statement) =>
      referencesOf(statement).flatMap((reference) =>
        resolveAudio(reference, index).map((resolution) => ({ document, statement, reference, ...resolution }))));
  }

  async function refreshDiagnostics() {
    const version = generation;
    for (const document of vscode.workspace.textDocuments.filter(isSupported)) {
      if (disposed || version !== generation) return;
      if (!vscode.workspace.getConfiguration('renpySoundPicker', document.uri).get('markMissingSounds', true)) {
        diagnostics.delete(document.uri);
        continue;
      }
      const documentVersion = document.version;
      const results = await resultsFor(document);
      if (disposed || version !== generation || document.version !== documentVersion) return;
      const warnings = results.filter((result) => ['missing', 'ambiguous'].includes(result.status)).map((result) => {
        const caseHint = result.caseMatch ? ` (did you mean ${result.caseMatch.relativePath}? names are case-sensitive)` : '';
        const message = result.status === 'ambiguous' ? result.reason : `Ren'Py sound not found: ${result.filename}${caseHint}`;
        const severity = result.status === 'ambiguous' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
        const diagnostic = new vscode.Diagnostic(rangeOf(document, result.reference), message, severity);
        diagnostic.source = 'Ren\'Py Sound Picker';
        return diagnostic;
      });
      diagnostics.set(document.uri, warnings);
    }
  }

  function scheduleDiagnostics() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void guarded('Checking sounds', refreshDiagnostics)();
    }, 250);
  }

  function invalidateScripts() {
    generation++;
    snapshots.clear();
    scanCache = undefined;
    scheduleDiagnostics();
  }

  function invalidateProject() {
    fileIndexes.clear();
    invalidateScripts();
    if (panel) void panel.webview.postMessage({ command: 'indexChanged' });
  }

  async function entryMetadata(entry) {
    try {
      const result = await metadata.get(entry.uri.fsPath);
      return { ...result, label: durationLabel(result.duration) };
    } catch (error) {
      const key = entry.uri.toString();
      const message = error instanceof Error ? error.message : String(error);
      if (!reportedMetadataErrors.has(key)) {
        output.appendLine(`Cannot read metadata for ${entry.uri.fsPath}: ${message}`);
        reportedMetadataErrors.add(key);
      }
      return { duration: null, label: 'Duration unavailable', format: path.extname(entry.name).slice(1).toUpperCase(), error: message };
    }
  }

  function editorTarget(editor) {
    if (!editor || !isSupported(editor.document)) return null;
    return { uri: editor.document.uri, offset: editor.document.offsetAt(editor.selection.active), version: editor.document.version };
  }

  async function targetFromArgs(args) {
    if (args && typeof args.uri === 'string' && Number.isInteger(args.offset)) {
      const uri = vscode.Uri.parse(args.uri);
      const document = await vscode.workspace.openTextDocument(uri);
      if (!isSupported(document) || args.offset < 0 || args.offset > document.getText().length) throw new Error('Invalid sound target.');
      if (args.version !== undefined && args.version !== document.version) throw new Error('The document changed. Hover the sound again.');
      return { uri, offset: args.offset, version: document.version };
    }
    return editorTarget(vscode.window.activeTextEditor);
  }

  async function insertEntry(entry, channel) {
    const target = lastTarget;
    if (!target) throw new Error('Open a .rpy or .rpym editor and choose an insertion point.');
    const document = await vscode.workspace.openTextDocument(target.uri);
    if (document.version !== target.version) throw new Error('The insertion document changed. Place the cursor again before inserting.');
    const root = await projectRoot(document.uri);
    if (root.toString() !== panelRoot.toString()) throw new Error('This sound belongs to a different project. Reopen the picker from the target editor.');
    const stat = await vscode.workspace.fs.stat(entry.uri);
    if (!(stat.type & vscode.FileType.File)) throw new Error('The selected sound is no longer a file. Refresh the picker.');
    const text = document.getText();
    const change = insertionEdit(text, target.offset, entry.relativePath, channel,
      document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code did not apply the sound insertion.');
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
    const position = document.positionAt(change.start + change.text.length);
    editor.selection = new vscode.Selection(position, position);
    lastTarget = { uri: document.uri, offset: document.offsetAt(position), version: document.version };
    vscode.window.setStatusBarMessage(`Inserted ${entry.relativePath}`, 2000);
    if (!vscode.workspace.getConfiguration('renpySoundPicker', document.uri).get('keepSoundPickerOpen', true)) panel?.dispose();
  }

  function webviewHtml(webview, picker) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'picker.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'picker.css'));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${escapeHtml(style)}"><title>Ren'Py Sound Picker</title></head>
<body data-picker="${picker ? 'true' : 'false'}" data-session="${panelRequest}">
<div class="toolbar">
  <section aria-label="Audio preview" class="player">
    <strong id="playingName">Choose a sound to preview</strong>
    <div id="playingPath" class="path"></div><div id="metadata" class="meta"></div>
    <audio id="audio" controls preload="none"></audio>
    <button id="playAgain" type="button">Play</button><button id="stop" type="button">Stop</button>
    <button id="reveal" type="button" disabled>Open file location</button>
    <div id="playerError" class="error" role="alert"></div>
    <div class="meta">Preview plays the file itself; Ren'Py playback prefixes and runtime channel behavior are not emulated.</div>
  </section>
  <section id="pickerToolbar" ${picker ? '' : 'hidden'}>
    <div class="search-row"><input id="search" type="search" placeholder="Search sound names or paths..." aria-label="Search sounds">
      <select id="searchMode" aria-label="Search mode"><option value="nameSequence">Name sequence</option><option value="crossPartial">Cross partial</option></select>
      <select id="channel" aria-label="Channel for new statements"><option value="sound">New: sound</option><option value="music">New: music</option></select>
      <button id="refresh" type="button">Refresh</button></div>
    <div id="count" class="meta"></div>
    <div class="meta">Preview does not insert. Insert replaces the sound at your editor cursor; elsewhere it adds a play statement below the line.</div>
  </section>
</div>
<div id="notice" class="meta" role="status"></div><div id="actionError" class="error" role="alert"></div>
<div id="grid" class="grid"></div><div id="empty" class="empty" hidden>No matching sounds.</div>
<script nonce="${nonce}" src="${escapeHtml(script)}"></script></body></html>`;
  }

  async function loadPanel(root, picker, previewEntry) {
    const request = ++panelRequest;
    playbackRequest++;
    await panel?.webview.postMessage({ command: 'stop' });
    if (disposed) return false;
    if (!panel) {
      panel = vscode.window.createWebviewPanel('renpySoundPicker', 'Ren\'Py Sound Picker', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [root, vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
      panelDisposables.push(panel.onDidDispose(() => {
        panel = undefined;
        panelEntries.clear();
        panelRequest++;
        playbackRequest++;
        for (const disposable of panelDisposables.splice(0)) disposable.dispose();
      }));
      panelDisposables.push(panel.webview.onDidReceiveMessage(guarded('Sound panel', async (message) => {
        if (!message || typeof message.command !== 'string') throw new Error('Invalid sound panel message.');
        if (message.session !== panelRequest) return;
        if (message.command === 'ready') {
          if (panelLoaded) await panel.webview.postMessage({ command: 'entries', entries: [...panelEntries.values()].map(serializeEntry) });
          if (pendingPlay) {
            const entry = pendingPlay;
            pendingPlay = undefined;
            await playEntry(entry);
          }
          return;
        }
        if (message.command === 'refresh') { invalidateProject(); await loadPanel(panelRoot, true); return; }
        const entry = typeof message.id === 'string' ? panelEntries.get(message.id) : undefined;
        if (!entry) throw new Error('Sound is no longer in this panel. Refresh the picker.');
        try {
          if (message.command === 'preview') await playEntry(entry);
          else if (message.command === 'insert' && ['sound', 'music'].includes(message.channel)) await insertEntry(entry, message.channel);
          else if (message.command === 'reveal') await vscode.commands.executeCommand('revealFileInOS', entry.uri);
          else throw new Error('Unsupported sound panel action.');
        } catch (error) {
          await panel?.webview.postMessage({ command: 'actionError', message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      })));
    }
    panelRoot = root;
    pendingPlay = previewEntry;
    panelLoaded = false;
    panelEntries = new Map(previewEntry ? [[previewEntry.uri.toString(), previewEntry]] : []);
    panel.webview.options = {
      enableScripts: true, localResourceRoots: [root, vscode.Uri.joinPath(context.extensionUri, 'media')]
    };
    panel.webview.html = webviewHtml(panel.webview, picker);
    panel.reveal(vscode.ViewColumn.Beside, true);
    // Index after the panel is visible so large projects show the UI immediately.
    const snapshot = await currentRootSnapshot(root);
    if (disposed || request !== panelRequest || !panel) return false;
    panelEntries = new Map(snapshot.index.entries.map((entry) => [entry.uri.toString(), entry]));
    if (previewEntry) panelEntries.set(previewEntry.uri.toString(), previewEntry);
    panelLoaded = true;
    await panel.webview.postMessage({ command: 'entries', entries: [...panelEntries.values()].map(serializeEntry) });
    return true;
  }

  function serializeEntry(entry) {
    return { id: entry.uri.toString(), name: entry.name, relativePath: entry.relativePath, fullPath: entry.uri.fsPath };
  }

  async function playEntry(entry) {
    const currentPanel = panel;
    const request = ++playbackRequest;
    await currentPanel.webview.postMessage({ command: 'stop' });
    const result = await entryMetadata(entry);
    if (request !== playbackRequest || panel !== currentPanel) return;
    await currentPanel.webview.postMessage({
      command: 'play', entry: serializeEntry(entry),
      src: currentPanel.webview.asWebviewUri(entry.uri).toString(), metadata: result
    });
  }

  async function playAtCursor(args) {
    const target = await targetFromArgs(args);
    if (!target) throw new Error('Open a .rpy or .rpym file and place the cursor on a sound reference.');
    const document = await vscode.workspace.openTextDocument(target.uri);
    const match = referenceAt(document.getText(), target.offset);
    if (!match?.reference) throw new Error('Place the cursor on the sound or individual playlist item to preview.');
    if (match.reference.type === 'incomplete') throw new Error('This audio statement does not have a sound to preview yet.');
    const snapshot = await currentSnapshot(target.uri);
    const found = resolveAudio(match.reference, snapshot.index);
    const playable = found.filter((result) => result.status === 'found');
    if (!playable.length) {
      vscode.window.showInformationMessage(found.map((result) => result.reason || (result.status === 'silence' ? 'Silence has no audio file.' : `Sound not found: ${result.filename}`)).join('\n'));
      return;
    }
    let selected = playable[0];
    if (playable.length > 1) {
      selected = await vscode.window.showQuickPick(playable.map((result) => ({ label: result.entry.relativePath, result })), {
        placeHolder: 'Choose an audio file from this alias playlist'
      }).then((item) => item?.result);
      if (!selected) return;
    }
    lastTarget = target;
    await loadPanel(snapshot.root, false, selected.entry);
  }

  async function scanWorkspace(token, progress) {
    if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a Ren\'Py project workspace before scanning.');
    const uris = await vscode.workspace.findFiles('**/*.{rpy,rpym}', EXCLUDE, undefined, token);
    for (const document of vscode.workspace.textDocuments) {
      if (isSupported(document) && document.isDirty && vscode.workspace.getWorkspaceFolder(document.uri) &&
          !uris.some((uri) => uri.toString() === document.uri.toString())) uris.push(document.uri);
    }
    const results = [];
    const version = generation;
    for (let index = 0; index < uris.length; index++) {
      if (token?.isCancellationRequested) return null;
      const uri = uris[index];
      const [text, snapshot] = await Promise.all([textFor(uri), currentSnapshot(uri)]);
      for (const statement of parseAudio(text)) {
        for (const reference of referencesOf(statement)) {
          for (const resolution of resolveAudio(reference, snapshot.index)) {
            if (!['missing', 'ambiguous', 'unverifiable'].includes(resolution.status)) continue;
            results.push({ uri, statement, reference, ...resolution, ...positionOf(text, reference.start) });
          }
        }
      }
      progress?.report({ increment: 100 / Math.max(1, uris.length), message: `${index + 1}/${uris.length} scripts` });
    }
    if (token?.isCancellationRequested) return null;
    if (version !== generation) throw new Error('Project changed during the scan. Run Rescan for current results.');
    return results;
  }

  async function showOverview(force) {
    const dirty = vscode.workspace.textDocuments.some((document) => isSupported(document) && document.isDirty);
    let results;
    if (!force && !dirty && scanCache && Date.now() - scanCache.time < SCAN_CACHE_MS) results = scanCache.results;
    else {
      if (force) invalidateProject();
      results = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Scanning Ren\'Py sounds', cancellable: true
      }, (progress, token) => scanWorkspace(token, progress));
      if (results === null) { vscode.window.setStatusBarMessage('Sound scan cancelled', 2000); return; }
      if (!dirty) scanCache = { time: Date.now(), results };
    }
    if (!results.length) {
      vscode.window.showInformationMessage('No missing, ambiguous, or unverifiable static audio references found in loose project scripts. Archives and Python audio calls are not inspected.');
      return results;
    }
    const items = results.map((result) => ({
      label: `${result.status === 'missing' ? '$(warning) Missing' : result.status === 'ambiguous' ? '$(info) Multiple matches' : '$(question) Unverifiable'}: ${result.filename || result.reference.value}`,
      description: `${vscode.workspace.asRelativePath(result.uri)}:${result.line + 1}`,
      detail: result.reason || result.lineText.trim(),
      result
    }));
    const missing = results.filter((result) => result.status === 'missing').length;
    const ambiguous = results.filter((result) => result.status === 'ambiguous').length;
    const item = await vscode.window.showQuickPick(items, {
      title: `${missing} missing, ${ambiguous} multiple matches, ${results.length - missing - ambiguous} unverifiable audio references`,
      placeHolder: 'Choose a reference to open its file and line', matchOnDescription: true, matchOnDetail: true
    });
    if (item) {
      const document = await vscode.workspace.openTextDocument(item.result.uri);
      const current = (await resultsFor(document)).find((result) =>
        result.reference.start === item.result.reference.start && result.status === item.result.status &&
        result.reference.value === item.result.reference.value);
      if (!current) throw new Error('That reference changed while the overview was open. Rescan to navigate to current results.');
      await vscode.window.showTextDocument(document, { selection: rangeOf(document, item.result.reference) });
    }
    return results;
  }

  const insertStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  insertStatus.text = '$(unmute) Insert Ren\'Py Sound';
  insertStatus.command = 'renpySoundPicker.insertSoundFromProject';
  insertStatus.tooltip = 'Search, preview, and insert project audio';
  const missingStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  missingStatus.text = '$(list-selection) Ren\'Py Missing Sounds';
  missingStatus.command = 'renpySoundPicker.listMissingSounds';
  missingStatus.tooltip = 'List missing, multiple-match, and unverifiable static audio references';
  function updateEditor() {
    const target = editorTarget(vscode.window.activeTextEditor);
    if (target) lastTarget = target;
    for (const item of [insertStatus, missingStatus]) target ? item.show() : item.hide();
  }

  const register = (name, action) => vscode.commands.registerCommand(`renpySoundPicker.${name}`, guarded(name, action));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onFileEvent = (uri) => {
    if (EXCLUDED_PATH.test(uri.path)) return;
    const extension = path.extname(uri.fsPath).toLowerCase();
    if (extension === '.rpa' || AUDIO_EXTENSIONS.has(extension)) invalidateProject();
    // Saved script contents are re-read through the modification-keyed definition cache.
    else if (extension === '.rpy' || extension === '.rpym') invalidateScripts();
  };
  const onFileListEvent = (uri) => {
    if (EXCLUDED_PATH.test(uri.path)) return;
    const extension = path.extname(uri.fsPath).toLowerCase();
    if (['.rpa', '.rpy', '.rpym'].includes(extension) || AUDIO_EXTENSIONS.has(extension)) invalidateProject();
  };
  context.subscriptions.push(output, diagnostics, insertStatus, missingStatus, watcher,
    watcher.onDidCreate(onFileListEvent), watcher.onDidChange(onFileEvent), watcher.onDidDelete(onFileListEvent),
    register('playSound', playAtCursor),
    register('insertSoundFromProject', async (args) => {
      const target = await targetFromArgs(args);
      if (!target) throw new Error('Open a .rpy or .rpym editor to insert a sound.');
      lastTarget = target;
      pendingPlay = undefined;
      await loadPanel(await projectRoot(target.uri), true);
    }),
    register('listMissingSounds', () => showOverview(false)),
    register('rescanMissingSounds', () => showOverview(true)),
    register('refreshIndex', async () => {
      definitionCache.clear();
      metadata.clear();
      reportedMetadataErrors.clear();
      invalidateProject();
      if (panel) await loadPanel(panelRoot, true);
      vscode.window.showInformationMessage('Ren\'Py sound index refreshed.');
    }),
    vscode.languages.registerHoverProvider(SELECTORS, {
      provideHover: guarded('Sound hover', async (document, position) => {
        if (!isSupported(document)) return null;
        const target = referenceAt(document.getText(), document.offsetAt(position));
        if (!target?.reference || ['dynamic', 'incomplete'].includes(target.reference.type)) return null;
        const snapshot = await currentSnapshot(document.uri);
        const resolutions = resolveAudio(target.reference, snapshot.index);
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**Ren'Py ${target.statement.kind} audio**\n\n`);
        markdown.appendCodeblock(document.getText(rangeOf(document, target.reference)), 'renpy');
        const playable = resolutions.some((resolution) => resolution.status === 'found');
        if (playable) {
          const args = { uri: document.uri.toString(), offset: target.reference.start, version: document.version };
          const command = `command:renpySoundPicker.playSound?${encodeURIComponent(JSON.stringify([args]))}`;
          markdown.isTrusted = { enabledCommands: ['renpySoundPicker.playSound'] };
          markdown.appendMarkdown(`[Play sound](${command})\n\n`);
        }
        for (const resolution of resolutions.slice(0, 10)) {
          if (resolution.status === 'found') {
            const info = await entryMetadata(resolution.entry);
            markdown.appendText(`${info.label} | ${info.format}\n`);
            markdown.appendCodeblock(resolution.entry.uri.fsPath, 'text');
            if (info.error) markdown.appendText(`Metadata unavailable: ${info.error}\n`);
          } else markdown.appendText(`${resolution.reason || (resolution.status === 'silence' ? 'Silence: no file required.' : `Sound not found: ${resolution.filename}`)}\n`);
        }
        if (resolutions.length > 10) markdown.appendText(`${resolutions.length - 10} additional playlist files. Use Play sound to choose a file.`);
        return new vscode.Hover(markdown, rangeOf(document, target.reference));
      })
    }),
    vscode.languages.registerCodeActionsProvider(SELECTORS, {
      provideCodeActions(document, range) {
        if (!isSupported(document)) return [];
        const action = new vscode.CodeAction('Insert sound from project', vscode.CodeActionKind.Refactor);
        action.command = {
          command: 'renpySoundPicker.insertSoundFromProject', title: action.title,
          arguments: [{ uri: document.uri.toString(), offset: document.offsetAt(range.start), version: document.version }]
        };
        return [action];
      }
    }, { providedCodeActionKinds: [vscode.CodeActionKind.Refactor] }),
    vscode.workspace.onDidOpenTextDocument((document) => { if (isSupported(document)) scheduleDiagnostics(); }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isSupported(event.document)) return;
      if (event.document.isDirty) editedUris.add(event.document.uri.toString());
      else editedUris.delete(event.document.uri.toString());
      invalidateScripts();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isSupported(document)) return;
      editedUris.delete(document.uri.toString());
      invalidateScripts();
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (!isSupported(document)) return;
      diagnostics.delete(document.uri);
      // Closing a clean document changes nothing; VS Code routinely discards
      // background documents, and reacting to that caused endless re-indexing.
      if (editedUris.delete(document.uri.toString())) invalidateScripts();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('renpySoundPicker')) invalidateProject(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(invalidateProject),
    vscode.window.onDidChangeActiveTextEditor(updateEditor),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // Model edits can move hidden editor selections without a new cursor choice.
      if (event.kind === undefined) return;
      if (event.textEditor !== vscode.window.activeTextEditor) return;
      const target = editorTarget(event.textEditor);
      if (target) lastTarget = target;
    }),
    { dispose() {
      disposed = true;
      clearTimeout(timer);
      panel?.dispose();
      snapshots.clear();
      fileIndexes.clear();
      definitionCache.clear();
      metadata.clear();
    } }
  );
  updateEditor();
  scheduleDiagnostics();
  return { scanWorkspace, resultsFor };
}

module.exports = { activate, deactivate() {} };
