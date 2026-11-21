const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseAudio, referencesOf, referenceAt, insertionEdit } = require('../audioReferences');
const { createIndex, resolveAudio } = require('../audioIndex');

function entries(...paths) { return paths.map((relativePath) => ({ relativePath })); }
function resolution(source, index) {
  return referencesOf(parseAudio(source)[0]).flatMap((reference) => resolveAudio(reference, index));
}
function apply(text, offset, file, channel, eol) {
  const edit = insertionEdit(text, offset, file, channel, eol);
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
}

test('parses only real statements, honoring comments, strings, escapes and custom channels', () => {
  const text = [
    '# play sound "ignored.ogg"',
    '"play sound \\"dialogue.ogg\\""',
    '"""',
    'play sound "docstring.ogg"',
    '"""',
    '    play custom_channel "audio/a#b\\\"c.ogg" fadein 1.0 # comment',
    '    queue music audio.theme noloop',
    '    voice r"voices\\line.wav"',
    '    define -10 audio.theme = "song.ogg"',
    '    define config.main_menu_music = "outside-scope.ogg"',
    '    play sound expression choose_sound()',
    '    queue music expression tracks',
    '    voice expression voice_path'
  ].join('\n');
  const parsed = parseAudio(text);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].channel, 'custom_channel');
  assert.equal(parsed[0].value.value, 'audio/a#b"c.ogg');
  assert.equal(text.slice(parsed[0].value.start, parsed[0].value.end), '"audio/a#b\\"c.ogg"');
  assert.equal(parsed[1].value.value, 'theme');
  assert.equal(parsed[2].value.value, 'voices\\line.wav');
  assert.equal(parsed[3].name, 'theme');
});

test('literal multiline playlists retain precise item ranges; arbitrary expressions are unverifiable', () => {
  const text = 'queue music [\n  "a.ogg", # first\n  audio.theme,\n  "b.ogg",\n] fadein 1.0';
  const parsed = parseAudio(text)[0];
  assert.deepEqual(referencesOf(parsed).map((item) => item.value), ['a.ogg', 'theme', 'b.ogg']);
  assert.equal(referenceAt(text, text.indexOf('theme')).reference.value, 'theme');
  assert.equal(parseAudio('play sound "prefix" + name')[0].value.type, 'dynamic');
  assert.equal(parseAudio('define audio.runtime = choose_sound()')[0].value.type, 'dynamic');
});

test('lookup uses game first, then ordered audio directories, never approximate basenames', () => {
  const index = createIndex(entries('theme.ogg', 'audio/theme.ogg', 'music/theme.ogg', 'other/lost.ogg'));
  assert.equal(resolution('play music "theme.ogg"', index)[0].entry.relativePath, 'theme.ogg');
  assert.equal(resolution('play music "lost.ogg"', index)[0].status, 'missing');
  const configured = createIndex(entries('music/theme.ogg', 'audio/theme.ogg'), [], ['music', 'audio']);
  assert.equal(resolution('play music "theme.ogg"', configured)[0].entry.relativePath, 'music/theme.ogg');
  assert.equal(resolution('play music "music/theme.ogg"', configured)[0].entry.relativePath, 'music/theme.ogg');
  const unusual = createIndex(entries('audio/track.custom'));
  assert.equal(resolution('play sound "audio/track.custom"', unusual)[0].status, 'found', 'existence is independent of recognized extensions');
  assert.equal(unusual.entries.length, 0, 'picker discovery is restricted to RenPy formats');
});

test('automatic aliases use identifier basenames, alphabetical precedence and eligible extensions', () => {
  const index = createIndex(entries(
    'audio/z/Town_theme.ogg', 'audio/a/Town_theme.mp3', 'audio/no-alias.ogg',
    'audio/8track.opus', 'audio/flac_only.flac', 'elsewhere/hidden.ogg', 'audio/else.ogg'
  ));
  assert.equal(resolution('play music town_theme', index)[0].entry.relativePath, 'audio/a/Town_theme.mp3');
  for (const alias of ['no_alias', 'hidden', 'flac_only', 'else']) {
    assert.equal(resolution(`play sound ${alias}`, index)[0].status, 'unverifiable');
  }
});

test('explicit aliases override automatic aliases, resolve chains and lists, and detect dynamic/cyclic definitions', () => {
  const definitions = parseAudio([
    'define audio.theme = "music/manual.flac"',
    'define audio.chain = audio.theme',
    'define audio.playlist = [chain, "audio/auto.ogg"]',
    'define audio.cycle = audio.cycle',
    'define audio.runtime = choose_track()'
  ].join('\n'));
  const index = createIndex(entries('audio/theme.ogg', 'music/manual.flac', 'audio/auto.ogg'), definitions);
  assert.equal(resolution('play music chain', index)[0].entry.relativePath, 'music/manual.flac');
  assert.deepEqual(resolution('play music playlist', index).map((item) => item.status), ['found', 'found']);
  assert.match(resolution('play music cycle', index)[0].reason, /Cyclic/);
  assert.equal(resolution('play music runtime', index)[0].status, 'unverifiable');
  assert.equal(resolution('play music unknown', index)[0].status, 'unverifiable');
  const missing = createIndex([], parseAudio('define audio.bad = "missing.ogg"'));
  assert.equal(resolution('play music bad', missing)[0].status, 'missing');
});

test('prefixes, silence, archives and invalid paths do not cause false missing-file warnings', () => {
  const index = createIndex(entries('audio/waves.opus'));
  assert.equal(resolution('play music "<from 5 to 15.5>waves.opus"', index)[0].status, 'found');
  assert.equal(resolution('play sound "<silence .5>"', index)[0].status, 'silence');
  assert.equal(resolution('play music "<sync music>waves.opus"', index)[0].status, 'found');
  assert.equal(resolution('play sound "../outside.wav"', index)[0].status, 'unverifiable');
  assert.equal(resolution('play sound "missing.wav"', createIndex([], [], ['audio'], true))[0].status, 'unverifiable');
  assert.throws(() => createIndex([], [], ['../outside']), /inside the game/);
  assert.equal(resolution('play sound "audio/waves.opus"', createIndex([]))[0].status, 'missing');
});

test('a file that matches only by case is reported as a case mismatch, not silently found', () => {
  const index = createIndex(entries('audio/Struggle.wav', 'audio/other.ogg'));
  const [result] = resolution('play sound "struggle.wav"', index);
  assert.equal(result.status, 'missing');
  assert.equal(result.caseMatch.relativePath, 'audio/Struggle.wav');
  assert.match(result.reason, /case/);
  // A case-only match outranks the vague archive fallback.
  const archived = createIndex(entries('audio/Struggle.wav'), [], ['audio'], true);
  assert.equal(resolution('play sound "struggle.wav"', archived)[0].status, 'missing');
});

test('insertion replaces one sound and preserves channel, modifiers, comments and other playlist items', () => {
  const text = '    play music "old.ogg" fadeout 1.0 loop # keep';
  assert.equal(apply(text, text.indexOf('old'), 'audio/new "track".ogg'), '    play music "audio/new \\"track\\".ogg" fadeout 1.0 loop # keep');
  const playlist = '    queue custom ["a.ogg",\n        "b.ogg"] volume 0.5 # keep';
  assert.equal(apply(playlist, playlist.indexOf('b.ogg'), 'audio/new.ogg'), '    queue custom ["a.ogg",\n        "audio/new.ogg"] volume 0.5 # keep');
  assert.throws(() => apply(playlist, playlist.indexOf('queue'), 'new.ogg'), /playlist item/);
  assert.equal(apply('voice "old.ogg"', 8, 'voice/new.ogg'), 'voice "voice/new.ogg"');
});

test('new insertion uses indentation/EOL and refuses dynamic statements', () => {
  assert.equal(apply('    "Dialogue"\r\n    return\r\n', 8, 'audio/new.ogg', 'sound', '\r\n'),
    '    "Dialogue"\r\n    play sound "audio/new.ogg"\r\n    return\r\n');
  assert.equal(apply('    pass', 6, 'music/new.ogg', 'music'), '    pass\n    play music "music/new.ogg"');
  assert.throws(() => apply('play sound expression get_sound()', 15, 'a.ogg'), /expression/);
  assert.throws(() => apply('play sound get_sound()', 15, 'a.ogg'), /Dynamic/);
  assert.throws(() => apply('"""dialogue\nmore dialogue\n"""', 16, 'a.ogg'), /multiline string/);
});
