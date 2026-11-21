const fs = require('fs/promises');

async function readMetadata(filename) {
  const { parseFile } = await import('music-metadata');
  const metadata = await parseFile(filename, { duration: true, skipCovers: true });
  const { duration, codec, container, sampleRate, numberOfChannels } = metadata.format;
  if (!codec && !container) throw new Error('The file does not contain recognized audio metadata.');
  return {
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
    format: codec || container || 'Unknown format',
    sampleRate,
    channels: numberOfChannels
  };
}

function createMetadataCache() {
  const cache = new Map();
  return {
    clear() { cache.clear(); },
    async get(filename) {
      const stat = await fs.stat(filename);
      const key = `${stat.mtimeMs}:${stat.size}`;
      const existing = cache.get(filename);
      if (existing?.key === key) return existing.promise;
      const promise = readMetadata(filename);
      cache.set(filename, { key, promise });
      return promise;
    }
  };
}

function durationLabel(seconds) {
  if (seconds === null || seconds === undefined) return 'Duration unknown';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor(rounded / 60) % 60;
  const remaining = String(rounded % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remaining}` : `${minutes}:${remaining}`;
}

module.exports = { readMetadata, createMetadataCache, durationLabel };
