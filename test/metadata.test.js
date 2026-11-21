const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readMetadata, createMetadataCache } = require('../audioMetadata');
const { wav } = require('./fixtures');

test('reads measurable duration and invalidates cached metadata when a file changes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'renpy-sound-metadata-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'tone.wav');
  await fs.writeFile(filename, wav(1.25));
  const metadata = await readMetadata(filename);
  assert.ok(Math.abs(metadata.duration - 1.25) < 0.001);
  assert.equal(metadata.channels, 1);
  const cache = createMetadataCache();
  assert.ok(Math.abs((await cache.get(filename)).duration - 1.25) < 0.001);
  await fs.writeFile(filename, wav(2));
  assert.equal((await cache.get(filename)).duration, 2);
});

test('corrupt or missing audio raises an explicit metadata error', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'renpy-sound-corrupt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'bad.wav');
  await fs.writeFile(filename, 'not an audio file');
  await assert.rejects(readMetadata(filename));
  await assert.rejects(createMetadataCache().get(path.join(directory, 'missing.wav')));
});

