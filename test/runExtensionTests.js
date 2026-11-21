const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { runTests } = require('@vscode/test-electron');
const { wav } = require('./fixtures');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'renpy-sound-extension-'));
  try {
    for (const project of ['first', 'second']) await fs.mkdir(path.join(root, project, 'game', 'audio'), { recursive: true });
    await fs.mkdir(path.join(root, 'first', 'renpy'), { recursive: true });
    await fs.writeFile(path.join(root, 'first', 'game', 'audio', 'tone.wav'), wav());
    await fs.writeFile(path.join(root, 'first', 'game', 'audio', 'corrupt.wav'), 'not audio');
    await fs.writeFile(path.join(root, 'first', 'game', 'aliases.rpy'), 'define audio.theme = "audio/tone.wav"\n');
    await fs.writeFile(path.join(root, 'first', 'game', 'script.rpy'), [
      'label start:',
      '    play music theme fadein 1.0',
      '    queue sound ["audio/tone.wav",',
      '        "missing.ogg"]',
      '    voice "missing-voice.wav"',
      '    play sound expression unknown_path',
      '    play music get_song()',
      '    return'
    ].join('\n'));
    await fs.writeFile(path.join(root, 'first', 'renpy', 'ignored.rpy'), 'play sound "engine-missing.wav"');
    await fs.writeFile(path.join(root, 'first', 'game', 'bom.rpy'), '\uFEFF# bom fixture\nplay sound "bom-missing.ogg"\n');
    await fs.writeFile(path.join(root, 'second', 'game', 'script.rpy'), 'play sound "audio/tone.wav"\n');
    const workspace = path.join(root, 'test.code-workspace');
    await fs.writeFile(workspace, JSON.stringify({
      folders: [{ path: path.join(root, 'first') }, { path: path.join(root, 'second', 'game') }],
      settings: { 'security.workspace.trust.enabled': false }
    }));
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const options = {
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, 'extensionHostTests.js'),
      launchArgs: [
        workspace, '--disable-extensions', '--disable-workspace-trust',
        '--user-data-dir', path.join(root, 'profile'),
        '--extensions-dir', path.join(root, 'extensions'),
        '--skip-welcome', '--skip-release-notes',
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'
      ]
    };
    await runTests({ ...options, version: '1.90.2', extensionTestsEnv: { SOUND_TEST_UI: '0' } });
    await runTests({
      ...options,
      version: 'stable',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionTestsEnv: { SOUND_TEST_UI: '1', SOUND_TEST_CDP_PORT: String(port) }
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
