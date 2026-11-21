function wav(seconds = 1.25) {
  const sampleRate = 8000;
  const length = Math.round(seconds * sampleRate) * 2;
  const buffer = Buffer.alloc(44 + length);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + length, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(length, 40);
  for (let offset = 0; offset < length / 2; offset++) {
    buffer.writeInt16LE(Math.round(Math.sin(offset / sampleRate * Math.PI * 2 * 440) * 1500), 44 + offset * 2);
  }
  return buffer;
}

module.exports = { wav };
