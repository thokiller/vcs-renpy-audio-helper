const path = require('path');
const { audioFilename } = require('./audioReferences');

const AUDIO_EXTENSIONS = new Set(['.opus', '.ogg', '.mp3', '.mp2', '.flac', '.wav']);
const AUTO_EXTENSIONS = new Set(['.opus', '.ogg', '.mp3', '.mp2', '.wav']);
const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

function normalizeDirectories(directories) {
  if (!Array.isArray(directories) || directories.some((value) => typeof value !== 'string')) {
    throw new Error('audioDirectories must be an array of game-relative directory paths.');
  }
  return directories.map((value) => {
    const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
    if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) ||
        normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
      throw new Error(`Audio lookup directory must stay inside the game directory: ${value}`);
    }
    return normalized === '.' ? '' : normalized.replace(/\/$/, '');
  });
}

function createIndex(entries, definitions = [], directories = ['audio'], hasArchives = false) {
  directories = normalizeDirectories(directories);
  const sorted = [...entries].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const files = new Map(sorted.map((entry) => [entry.relativePath, entry]));
  const caseInsensitiveFiles = new Map();
  for (const entry of sorted) {
    const lowered = entry.relativePath.toLowerCase();
    if (!caseInsensitiveFiles.has(lowered)) caseInsensitiveFiles.set(lowered, entry);
  }
  const aliases = new Map();
  for (const entry of sorted) {
    const extension = path.posix.extname(entry.relativePath);
    const stem = path.posix.basename(entry.relativePath, extension).toLowerCase();
    if (!AUTO_EXTENSIONS.has(extension.toLowerCase()) || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(stem) ||
        PYTHON_KEYWORDS.has(stem) || !directories.some((directory) => !directory || entry.relativePath.startsWith(`${directory}/`))) continue;
    if (!aliases.has(stem)) aliases.set(stem, { type: 'entry', entry });
  }
  const explicit = new Map();
  for (const definition of definitions) {
    if (explicit.has(definition.name)) {
      explicit.set(definition.name, { type: 'dynamic', value: 'Multiple audio definitions cannot be ordered statically.' });
    } else explicit.set(definition.name, definition.value);
  }
  for (const [name, value] of explicit) aliases.set(name, value);
  return {
    entries: sorted.filter((entry) => AUDIO_EXTENSIONS.has(path.posix.extname(entry.relativePath).toLowerCase())),
    files, caseInsensitiveFiles, aliases, directories, hasArchives
  };
}

function resolveAudio(reference, index, seen = new Set()) {
  if (reference.type === 'entry') return [{ status: 'found', entry: reference.entry }];
  if (reference.type === 'list') return reference.items.flatMap((item) => resolveAudio(item, index, seen));
  if (reference.type === 'dynamic') return [{ status: 'unverifiable', reason: reference.value || 'Runtime audio expression.' }];
  if (reference.type === 'alias') {
    if (seen.has(reference.value)) return [{ status: 'unverifiable', reason: `Cyclic audio alias: ${reference.value}` }];
    const value = index.aliases.get(reference.value);
    if (!value) return [{ status: 'unverifiable', reason: `Unknown audio alias: ${reference.value} (may be defined at runtime).` }];
    return resolveAudio(value, index, new Set([...seen, reference.value]));
  }
  const filename = audioFilename(reference.value);
  if (filename.type === 'silence') return [{ status: 'silence' }];
  if (filename.type === 'unverifiable') return [{ status: 'unverifiable', reason: filename.reason }];
  if (filename.value === '..' || filename.value.startsWith('../')) {
    return [{ status: 'unverifiable', reason: 'Audio path leaves the game directory.' }];
  }
  const candidates = [filename.value, ...index.directories.map((directory) => path.posix.join(directory, filename.value))];
  for (const candidate of candidates) {
    if (index.files.has(candidate)) return [{ status: 'found', entry: index.files.get(candidate) }];
  }
  for (const candidate of candidates) {
    const caseMatch = index.caseInsensitiveFiles.get(candidate.toLowerCase());
    if (caseMatch) {
      return [{
        status: 'missing', filename: filename.value, caseMatch,
        reason: `Only ${caseMatch.relativePath} matches ignoring case. Ren'Py file names are case-sensitive, so this breaks on non-Windows platforms.`
      }];
    }
  }
  if (index.hasArchives) return [{ status: 'unverifiable', reason: `${filename.value}: may be in an .rpa archive (not inspected).` }];
  return [{ status: 'missing', filename: filename.value }];
}

module.exports = { AUDIO_EXTENSIONS, createIndex, resolveAudio, normalizeDirectories };
