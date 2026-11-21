const path = require('path');

const MODIFIERS = new Set(['fadein', 'fadeout', 'loop', 'noloop', 'if_changed', 'volume']);

function decodeString(body, raw) {
  if (raw) return body;
  return body.replace(/\\(?:\r?\n|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/g, (escape) => {
    const value = escape.slice(1);
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', '"': '"', "'": "'" };
    if (value === '\n' || value === '\r\n') return '';
    if (Object.hasOwn(simple, value)) return simple[value];
    if (/^[xuU]/.test(value)) {
      const code = Number.parseInt(value.slice(1), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
    }
    if (/^[0-7]/.test(value)) return String.fromCodePoint(Number.parseInt(value, 8));
    return escape;
  });
}

function tokenize(text) {
  const tokens = [];
  let offset = 0;
  while (offset < text.length) {
    const start = offset;
    const character = text[offset];
    if (character === '\n') {
      tokens.push({ type: 'newline', value: '\n', start, end: ++offset });
      continue;
    }
    if (/\s/.test(character)) { offset++; continue; }
    if (character === '#') {
      while (offset < text.length && text[offset] !== '\n') offset++;
      continue;
    }
    if (character === '\\' && /[\r\n]/.test(text[offset + 1] || '')) {
      offset += text[offset + 1] === '\r' ? 3 : 2;
      continue;
    }
    const prefix = text.slice(offset).match(/^(?:[rRuU]|[rR][fF]|[fF][rR]|[fFbB])(?=['"])/);
    const prefixText = prefix ? prefix[0] : '';
    const quoteOffset = offset + prefixText.length;
    const quote = text[quoteOffset];
    if (quote === '"' || quote === "'") {
      const triple = text.slice(quoteOffset, quoteOffset + 3) === quote.repeat(3);
      const delimiter = quote.repeat(triple ? 3 : 1);
      const bodyStart = quoteOffset + delimiter.length;
      offset = bodyStart;
      let closed = false;
      while (offset < text.length) {
        if (text[offset] === '\\') { offset += 2; continue; }
        if (text.slice(offset, offset + delimiter.length) === delimiter) { closed = true; break; }
        if (!triple && text[offset] === '\n') break;
        offset++;
      }
      const body = text.slice(bodyStart, offset);
      if (closed) offset += delimiter.length;
      tokens.push({
        type: closed && !/[fb]/i.test(prefixText) ? 'string' : 'dynamic',
        value: decodeString(body, /r/i.test(prefixText)), start, end: offset
      });
      continue;
    }
    const identifier = text.slice(offset).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (identifier) {
      offset += identifier[0].length;
      tokens.push({ type: 'identifier', value: identifier[0], start, end: offset });
      continue;
    }
    tokens.push({ type: 'punctuation', value: character, start, end: ++offset });
  }
  return tokens;
}

function parseValue(tokens, cursor = 0) {
  const first = tokens[cursor];
  if (!first) return null;
  if (first.type === 'string') {
    return { value: { type: 'file', value: first.value, start: first.start, end: first.end }, next: cursor + 1 };
  }
  if (first.value === '[') {
    const items = [];
    let next = cursor + 1;
    while (next < tokens.length && tokens[next].value !== ']') {
      const item = parseValue(tokens, next);
      if (!item || item.value.type === 'list') return null;
      items.push(item.value);
      next = item.next;
      if (tokens[next]?.value === ',') next++;
      else if (tokens[next]?.value !== ']') return null;
    }
    if (tokens[next]?.value !== ']') return null;
    return { value: { type: 'list', items, start: first.start, end: tokens[next].end }, next: next + 1 };
  }
  if (first.type === 'identifier' && first.value !== 'expression') {
    let name = first.value;
    let next = cursor + 1;
    if (name === 'audio' && tokens[next]?.value === '.' && tokens[next + 1]?.type === 'identifier') {
      name = tokens[next + 1].value;
      next += 2;
    }
    return { value: { type: 'alias', value: name, start: first.start, end: tokens[next - 1].end }, next };
  }
  return null;
}

function parseStatement(tokens) {
  if (tokens[0]?.type !== 'identifier') return null;
  const kind = tokens[0]?.value;
  if (!['play', 'queue', 'voice', 'define'].includes(kind)) return null;
  let cursor = 1;
  let name;
  let channel;
  if (kind === 'define') {
    // Ren'Py allows an optional init priority before the definition.
    const priorityStart = cursor;
    while (tokens[cursor]?.type === 'punctuation' && /^[-0-9]$/.test(tokens[cursor].value)) cursor++;
    if (cursor !== priorityStart && !/^-?\d+$/.test(tokens.slice(priorityStart, cursor).map((token) => token.value).join(''))) return null;
    if (tokens[cursor]?.value !== 'audio' || tokens[cursor + 1]?.value !== '.' ||
        tokens[cursor + 2]?.type !== 'identifier' || tokens[cursor + 3]?.value !== '=') return null;
    name = tokens[cursor + 2].value;
    cursor += 4;
  } else if (kind !== 'voice') {
    if (tokens[cursor]?.type !== 'identifier') return null;
    channel = tokens[cursor++].value;
  }
  if (tokens[cursor]?.value === 'expression') return null;
  const first = tokens[cursor];
  const next = tokens[cursor + 1];
  const numberStart = next?.type === 'punctuation' && (/^[0-9]$/.test(next.value) ||
    (next.value === '.' && /^[0-9]$/.test(tokens[cursor + 2]?.value || '')));
  const missingBeforeModifier = first && ['volume', 'fadein', 'fadeout'].includes(first.value) && numberStart;
  if (kind !== 'define' && (!first || missingBeforeModifier)) {
    const position = first ? first.start : tokens[cursor - 1].end;
    return { kind, channel, value: { type: 'incomplete', start: position, end: position }, start: tokens[0].start, end: tokens[tokens.length - 1].end };
  }
  const parsed = parseValue(tokens, cursor);
  const tail = parsed && tokens[parsed.next];
  const isStatic = Boolean(parsed && (!tail || (kind !== 'define' && MODIFIERS.has(tail.value))));
  const start = tokens[0].start;
  const end = tokens[tokens.length - 1].end;
  const value = isStatic ? parsed.value : {
    type: 'dynamic', value: 'Runtime expression', start: tokens[cursor]?.start ?? end, end
  };
  return { kind, channel, name, value, start, end };
}

function parseAudio(text) {
  const statements = [];
  let line = [];
  let depth = 0;
  for (const token of tokenize(text)) {
    if (token.type === 'newline') {
      if (depth === 0) {
        const statement = parseStatement(line);
        if (statement) statements.push(statement);
        line = [];
      }
      continue;
    }
    line.push(token);
    if (['[', '(', '{'].includes(token.value) && token.type === 'punctuation') depth++;
    if ([']', ')', '}'].includes(token.value) && token.type === 'punctuation') depth = Math.max(0, depth - 1);
  }
  const statement = parseStatement(line);
  if (statement) statements.push(statement);
  return statements;
}

function referencesOf(statement) {
  if (statement.value.type === 'incomplete') return [];
  return statement.value.type === 'list' ? statement.value.items : [statement.value];
}

function referenceAt(text, offset) {
  const statements = parseAudio(text);
  for (const statement of statements) {
    const lineStart = text.lastIndexOf('\n', statement.start - 1) + 1;
    const newline = text.indexOf('\n', statement.end);
    const lineEnd = newline === -1 ? text.length : newline;
    if (offset < lineStart || offset > lineEnd) continue;
    if (statement.value.type === 'incomplete') return { statement, reference: statement.value };
    const items = referencesOf(statement);
    const reference = items.find((item) => offset >= item.start && offset <= item.end);
    return { statement, reference: reference || (items.length === 1 && statement.value.type !== 'list' ? items[0] : null) };
  }
  return null;
}

function insertionEdit(text, offset, relativePath, channel = 'sound', eol = '\n') {
  if (!['sound', 'music'].includes(channel)) throw new Error('Invalid insertion channel.');
  const quoted = JSON.stringify(relativePath);
  const target = referenceAt(text, offset);
  if (target) {
    if (!target.reference) throw new Error('Place the cursor on the playlist item to replace.');
    if (target.reference.type === 'dynamic') throw new Error('Dynamic audio statements cannot be safely replaced.');
    if (target.reference.type === 'incomplete') {
      const position = target.reference.start;
      const prefix = position > 0 && !/\s/.test(text[position - 1]) ? ' ' : '';
      const suffix = position < text.length && !/\s/.test(text[position]) ? ' ' : '';
      return { start: position, end: position, text: `${prefix}${quoted}${suffix}` };
    }
    return { start: target.reference.start, end: target.reference.end, text: quoted };
  }
  if (tokenize(text).some((token) => token.start <= offset && token.end > offset &&
      ['string', 'dynamic'].includes(token.type) && text.slice(token.start, token.end).includes('\n'))) {
    throw new Error('Cannot insert a statement inside a multiline string.');
  }
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const newline = text.indexOf('\n', offset);
  const lineEnd = newline === -1 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
  if (/^\s*(?:play|queue|voice|define\s+(?:-?\d+\s+)?audio\.)\b/.test(line)) {
    throw new Error('Place the cursor on a static sound reference; expression statements are ignored.');
  }
  const indent = line.match(/^\s*/)[0];
  if (newline === -1) return { start: text.length, end: text.length, text: `${eol}${indent}play ${channel} ${quoted}` };
  return { start: newline + 1, end: newline + 1, text: `${indent}play ${channel} ${quoted}${eol}` };
}

function audioFilename(value) {
  let filename = value;
  while (filename.startsWith('<')) {
    const end = filename.indexOf('>');
    if (end === -1) return { type: 'unverifiable', reason: 'Invalid audio playback prefix.' };
    const prefix = filename.slice(1, end).trim();
    if (/^silence\s+(?:\d+(?:\.\d*)?|\.\d+)$/.test(prefix) && end === filename.length - 1) return { type: 'silence' };
    if (!/^(?:from|to|loop|sync|volume)\s+\S+(?:\s+(?:from|to|loop|sync|volume)\s+\S+)*$/.test(prefix)) {
      return { type: 'unverifiable', reason: 'Unsupported audio playback prefix.' };
    }
    filename = filename.slice(end + 1);
  }
  if (!filename || filename.includes('\0') || path.posix.isAbsolute(filename.replace(/\\/g, '/')) ||
      /^[A-Za-z]:/.test(filename)) return { type: 'unverifiable', reason: 'Not a game-relative audio path.' };
  return { type: 'file', value: path.posix.normalize(filename.replace(/\\/g, '/')) };
}

module.exports = { parseAudio, referencesOf, referenceAt, insertionEdit, audioFilename };
