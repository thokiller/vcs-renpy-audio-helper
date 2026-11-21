// Temporary diagnostic: runs the extension read-only against a real project.
// Usage: set SOUND_PROBE_PROJECT and VSCODE_EXECUTABLE_PATH, then run with node.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const project = process.env.SOUND_PROBE_PROJECT;
  if (!project) throw new Error('Set SOUND_PROBE_PROJECT to the Ren\'Py project path.');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'renpy-sound-probe-'));
  try {
    await runTests({
      version: 'stable',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, 'probeHost.js'),
      launchArgs: [
        project, '--disable-extensions', '--disable-workspace-trust',
        '--user-data-dir', path.join(scratch, 'profile'),
        '--extensions-dir', path.join(scratch, 'extensions'),
        '--skip-welcome', '--skip-release-notes'
      ]
    });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
