# Ren'Py Sound Picker

A standalone Visual Studio Code extension for previewing, inserting, and checking
Ren'Py project sounds and music. Its picker follows the Ren'Py Image Preview UI,
but **the image extension is not required**.

## Features

- Hover a static sound reference for a **Play sound** action, duration, format,
  and the full resolved file path.
- Play opens an audio player beside the editor, with playback, seeking, volume,
  Stop, and Open file location controls. VS Code hovers themselves cannot embed
  interactive audio controls.
- Search project audio in a theme-aware card grid, using **Name sequence** or
  **Cross partial** matching against names and paths.
- Each card has separate **Play** and **Insert** buttons. Preview never edits code.
  Paths are visible; the full path is also available on hover over a card's path.
  Duration is loaded on demand when previewing, not for every file at startup.
- Warning squiggles identify definitively missing static audio files, including
  files that exist with different letter case (which breaks Ren'Py on
  non-Windows platforms); the warning names the actual file.
- A project-wide overview lists **Missing** and **Unverifiable** references,
  with navigation to their script and line.

Open a Ren'Py project root (containing `game`) or the `game` directory itself.
Projects in separate workspace folders are indexed independently.

## Supported statements

```renpy
define audio.theme = "music/theme.flac"
define audio.intro = ["audio/first.ogg", "audio/second.ogg"]

label start:
    play music theme fadein 1.0 loop
    queue sound ["audio/first.ogg",
                 "audio/second.ogg"] volume 0.5
    play custom_channel "audio/effect.wav"
    voice "voices/line.opus"
```

Simple static alias chains and `audio.name` references are supported. Dynamic
definitions are never evaluated. Comments, dialogue, and multiline strings are
not mistaken for audio statements.

`play`, `queue`, and `voice` statements using **expression** are ignored entirely.
Other runtime expressions and unknown aliases are listed as **Unverifiable**,
not falsely marked missing.

## Inserting audio

Use:

- **Ren'Py: Insert Sound From Project** in the Command Palette
- The **Insert Ren'Py Sound** status bar button
- The editor context menu or light-bulb refactoring action

While editing `.rpy` or `.rpym`:

- On an existing static audio statement, Insert replaces only the selected sound,
  preserving its channel, modifiers, indentation, and comments.
- In a playlist, put the cursor on the individual item to replace. Ambiguous
  playlist targets are rejected; other items are left untouched.
- On a `define audio.name` value, Insert replaces the selected static value.
- Elsewhere, Insert adds an indented `play sound "game-relative/path"` statement
  below the current line. Choose **New: music** to use music instead.
- Insert uses a safely quoted game-relative path, so it does not depend on an
  automatic alias or on the file's basename being unique.
- The panel stays open by default. The originating editor cursor remains the
  target when the panel takes focus. If that document changes without a new
  editor cursor target, insertion reports the stale target rather than guessing.

Ren'Py syntax is not inserted into ordinary Python files. Dynamic statements
and insertion inside multiline strings are rejected.

## Finding audio files

Lookup follows Ren'Py's order:

1. The project's game directory.
2. Audio lookup directories, defaulting to `audio`, relative to game.

For example, `"theme.ogg"` checks `game/theme.ogg`, then
`game/audio/theme.ogg`. A similarly named file somewhere else does not count.
The picker discovers loose audio anywhere under game, not just in `game/audio`.

Automatic audio aliases use lowercase Python-identifier basenames from audio
lookup directories and their subdirectories. Supported automatic alias extensions
are `.wav`, `.mp2`, `.mp3`, `.ogg`, and `.opus`; use an explicit definition or path
for FLAC. Alphabetically first paths win duplicate automatic names.
Explicit static definitions override automatic aliases. Multiple explicit
definitions that cannot be ordered statically are unverifiable.

Recognized filename prefixes (`from`, `to`, `loop`, `sync`, and `volume`) are
removed for file lookup. `<silence ...>` requires no file. **Preview plays the
actual file**, not Ren'Py's runtime prefix, channel, looping, or synchronization
semantics.

## Missing-sound overview

Commands:

- **Ren'Py: List Missing Static Sounds**
- **Ren'Py: Rescan Missing Static Sounds**
- **Ren'Py: Refresh Sound Index**

List/Rescan are also available in editor and sound-panel title menus and through
the **Ren'Py Missing Sounds** status bar button.

The overview scans `.rpy`/`.rpym` project files, includes unsaved changes, reports
progress, and supports cancellation. Saved-state results are cached for five
minutes. Rescan bypasses the cache; unsaved edits and relevant file/settings
changes invalidate it. Editor warnings update after a short debounce.

Scripts are parsed from disk with a modification-keyed cache, so the first use
in a large project takes a moment and later lookups stay fast. VS Code
discarding unmodified background documents does not trigger re-indexing.

Disabling warning squiggles does not disable the manual scanner or preview.
Read/scan failures are reported rather than presenting a partial scan as clean.
Engine `renpy`, `node_modules`, `.git`, `.vscode-test`, `cache`, `__pycache__`,
and `saves` directories are excluded.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `renpySoundPicker.audioDirectories` | `["audio"]` | Ordered game-relative lookup directories, matching your `config.audio_directories`. The game directory is always searched first. |
| `renpySoundPicker.markMissingSounds` | `true` | Warning diagnostics for definitively missing static files. |
| `renpySoundPicker.keepSoundPickerOpen` | `true` | Keep the panel open after insertion. |

Settings support per-project workspace-folder overrides. Audio directories must
stay within game. Python `config.audio_directories` assignments are **not**
automatically evaluated; configure the equivalent directories here.

## Formats and limitations

Indexed formats: **Opus, Ogg Vorbis, MP3, MP2, FLAC, and WAV**.

Playback uses VS Code's embedded browser. Codec support varies: a file that
Ren'Py accepts may not play in VS Code. Unsupported or corrupt previews show an
error; insertion and existence checking still work. Duration can be unknown.
Metadata read errors appear in the player/hover and the **Ren'Py Sound Picker**
Output channel.

This is a static assistant, **not a replacement for Ren'Py lint**:

- No `.rpa` archive extraction. An unresolved path in a project containing an
  archive is unverifiable, not definitely missing.
- No Python execution, arbitrary Python audio calls, screen/style audio
  properties, compiled scripts, or runtime configuration evaluation.
- No runtime alias ordering/conditions. Unknown, dynamic, conflicting, or cyclic
  aliases are unverifiable.
- Only local filesystem workspaces are supported.

## Development and tests

Use **Node.js 24 LTS** for development/building (packaging tools require at least
Node.js 22). Installed-extension users do not need Node.js, Python, FFmpeg, or
the image extension.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run test:extension
```

Open this folder in VS Code and press **F5** to launch an Extension Development
Host with other installed extensions disabled, then open a Ren'Py project there.

Unit tests cover parsing, path/alias resolution, safe insertion, and real WAV
duration (within 1 ms). Integration tests launch isolated temporary workspaces
on VS Code 1.90.2 and the current stable version. Current-version tests use
Playwright over a loopback-only debugging port to exercise the real webview's
search, playback, Stop, and insertion buttons. No additional browser installation
is needed; the test harness downloads VS Code. Its temporary profiles/projects
are removed after each run.

To measure responsiveness against a real project without modifying it, run
`node test\probeRealProject.js` with `SOUND_PROBE_PROJECT` set to the project
path and `VSCODE_EXECUTABLE_PATH` set to your VS Code executable. It reports
hover and scan timings plus missing-sound samples, read-only.

Installed development dependencies stay small: the audio metadata library that
ships with the extension, the VS Code test harness, and Playwright for webview
tests. The VSIX packaging tool is not installed; `npm run package` fetches the
pinned `@vscode/vsce` release through `npx` when packaging, so that step needs
network access the first time.

## Building and installing

Double-click **build-vsix.cmd**, or:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run package
```

The build helper restores locked dependencies, runs unit tests, and packages a
VSIX. Packaging also runs JavaScript syntax checks.

Install `renpy-sound-picker-0.0.1.vsix` using VS Code's Extensions menu:
**... > Install from VSIX...**, or:

```powershell
code --install-extension renpy-sound-picker-0.0.1.vsix
```

You can distribute that VSIX to friends; they only need VS Code 1.90 or newer.
The audio metadata dependency's file detector requires Node.js 20, supplied by
VS Code 1.90; this minimum is newer than the image extension's.

## Future public GitHub repository

The included workflows validate builds and tests on Windows:

- Branch/PR CI packages a downloadable VSIX artifact.
- Pushing a **v-prefixed tag**, such as `v0.0.1`, runs the release workflow and
  attaches the VSIX to a GitHub Release.
- Manually running the release workflow builds an artifact without publishing.

Before publishing, set your real publisher and repository metadata in
`package.json`. `local` is intentionally a placeholder for local VSIX builds.
Bump the package version before tagging. These workflows do not publish to the
VS Code Marketplace; Marketplace publication requires separate setup.

## License and attribution

GPL-2.0-only. The picker layout/search conventions and Windows/GitHub build
setup are adapted from **Ren'Py Image Preview**, also GPL-2.0-only.
Redistributed modifications remain under that license. Runtime dependencies
retain their own included licenses.
