/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const session = Number(document.body.dataset.session);
const picker = document.body.dataset.picker === 'true';
const audio = document.getElementById('audio');
const search = document.getElementById('search');
const mode = document.getElementById('searchMode');
const channel = document.getElementById('channel');
const grid = document.getElementById('grid');
const playingName = document.getElementById('playingName');
const playingPath = document.getElementById('playingPath');
const metadata = document.getElementById('metadata');
const playerError = document.getElementById('playerError');
const actionError = document.getElementById('actionError');
const reveal = document.getElementById('reveal');
const notice = document.getElementById('notice');
let entries = [];
let entriesLoaded = false;
let playingId;
let playVersion = 0;

const saved = vscode.getState();
if (saved) {
  search.value = saved.query || '';
  mode.value = saved.mode || 'nameSequence';
  channel.value = saved.channel || 'sound';
}
if (picker) notice.textContent = 'Indexing project sounds. Large projects can take a few seconds on first use.';

function post(command, extra = {}) {
  vscode.postMessage({ command, session, ...extra });
}

function normalize(value) {
  return value.toLowerCase().replace(/[._/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function render() {
  vscode.setState({ query: search.value, mode: mode.value, channel: channel.value });
  grid.replaceChildren();
  if (!picker) return;
  const query = normalize(search.value);
  const filtered = entries.filter((entry) => {
    const text = normalize(`${entry.name} ${entry.relativePath}`);
    return mode.value === 'crossPartial' ? query.split(' ').every((part) => text.includes(part)) : text.includes(query);
  });
  document.getElementById('count').textContent = `${filtered.length} sound${filtered.length === 1 ? '' : 's'}`;
  document.getElementById('empty').hidden = !entriesLoaded || filtered.length !== 0;
  const fragment = document.createDocumentFragment();
  for (const entry of filtered) {
    const card = document.createElement('article');
    card.className = 'card';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = entry.name;
    const path = document.createElement('div');
    path.className = 'path';
    path.textContent = entry.relativePath;
    path.title = entry.fullPath;
    const details = document.createElement('div');
    details.className = 'meta';
    details.dataset.metadataId = entry.id;
    details.textContent = 'Duration shown when previewed';
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [command, text] of [['preview', 'Play'], ['insert', 'Insert']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', `${text} ${entry.relativePath}`);
      button.addEventListener('click', () => {
        actionError.textContent = '';
        post(command, { id: entry.id, channel: channel.value });
      });
      actions.append(button);
    }
    card.append(label, path, details, actions);
    fragment.append(card);
  }
  grid.append(fragment);
}

function stop() {
  playVersion++;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

async function requestPlayback() {
  if (!audio.getAttribute('src')) {
    playerError.textContent = 'Choose a sound with a Play button first.';
    return;
  }
  const version = ++playVersion;
  try {
    await audio.play();
    if (version === playVersion) playerError.textContent = '';
  } catch (error) {
    if (version === playVersion) {
      playerError.textContent = `Cannot play this file: ${error.message}. The codec may not be supported by VS Code. You can still insert the sound.`;
    }
  }
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.command === 'entries') {
    entries = message.entries;
    entriesLoaded = true;
    notice.textContent = '';
    render();
  } else if (message.command === 'play') {
    stop();
    playingId = message.entry.id;
    playingName.textContent = message.entry.name;
    playingPath.textContent = message.entry.fullPath;
    metadata.textContent = `${message.metadata.label} | ${message.metadata.format}`;
    playerError.textContent = message.metadata.error ? `Metadata unavailable: ${message.metadata.error}` : '';
    reveal.disabled = false;
    audio.src = message.src;
    for (const element of grid.querySelectorAll('[data-metadata-id]')) {
      if (element.dataset.metadataId === playingId) element.textContent = metadata.textContent;
    }
    void requestPlayback();
  } else if (message.command === 'stop') stop();
  else if (message.command === 'actionError') actionError.textContent = message.message;
  else if (message.command === 'indexChanged') notice.textContent = 'Project files changed. Refresh to update this sound list.';
});

audio.addEventListener('error', () => {
  if (!audio.getAttribute('src')) return;
  playerError.textContent = 'Audio could not be loaded or decoded. The file may be missing, corrupt, or use an unsupported codec. Insertion and file checks do not depend on playback.';
});
document.getElementById('stop').addEventListener('click', () => {
  playVersion++;
  audio.pause();
  if (Number.isFinite(audio.duration)) audio.currentTime = 0;
});
document.getElementById('playAgain').addEventListener('click', () => { void requestPlayback(); });
document.getElementById('refresh').addEventListener('click', () => { stop(); post('refresh'); });
reveal.addEventListener('click', () => { if (playingId) post('reveal', { id: playingId }); });
search.addEventListener('input', render);
mode.addEventListener('change', render);
channel.addEventListener('change', render);
window.addEventListener('pagehide', stop);
post('ready');
