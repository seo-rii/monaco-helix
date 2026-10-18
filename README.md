# monaco-helix

Helix-style, selection-first modal editing for [Monaco Editor](https://microsoft.github.io/monaco-editor/).

`monaco-helix` adds Normal, Insert, and Select modes to an existing Monaco
editor. It is a standalone TypeScript ESM package with no framework dependency.
Monaco Editor `^0.55.1` is a peer dependency supplied by your application.

The controller and selection helpers are **adapted from
[zixiao-labs/logos](https://github.com/zixiao-labs/logos)** at
[commit `69e08e1`](https://github.com/zixiao-labs/logos/tree/69e08e1397cd0831a624183c171f129c0e293f61),
under the MIT License. See [third-party notices](THIRD_PARTY_NOTICES.md) and the
[implementation review](docs/review.md) for provenance and changes.

## Features

- Selection-first editing with Normal, Insert, and Select modes.
- Motions, counts, character finds, text objects, and multiple selections.
- Delete, change, yank, paste, registers, search, and regex selection prompts.
- Unicode grapheme-aware movement and selection helpers.
- Undo/redo, repeat insertion, and read-only editor support.
- Optional mode status element, built-in prompts, mode events, and host commands.
- Disposal and model lifecycle handling for applications that switch editors.

This is a subset of Helix behavior. It does not run Helix, load its configuration
or plugins, or provide tree-sitter text objects, shell pipelines, macros, or
window management. See the [supported keymap](docs/keymap.md).

## Install

The initial release is available from GitHub. It is not published to the npm
registry.

```sh
npm install github:seo-rii/monaco-helix monaco-editor@^0.55.1
```

The GitHub install runs the package's `prepare` build. For local development,
clone the repository, run `npm ci` and `npm run build`, then install its path in
your application:

```sh
npm install /absolute/path/to/monaco-helix monaco-editor@^0.55.1
```

## Usage

This package runs in the browser. In an SSR application, dynamically import
Monaco and `monaco-helix` inside the client or mounted lifecycle before creating
the editor and binding.

Create and configure Monaco as usual, including its workers and language
services. Then attach Helix mode:

```ts
import * as monaco from 'monaco-editor';
import { initHelixMode } from 'monaco-helix';
import 'monaco-helix/style.css';

const editor = monaco.editor.create(document.getElementById('editor')!, {
  value: 'const message = "hello";\n',
  language: 'typescript',
});

const helix = initHelixMode(editor, document.getElementById('mode') ?? undefined, {
  onModeChange(mode) {
    console.log(mode);
  },
  onCommand(command) {
    // Handle application-specific commands such as :w in your host app.
    console.log('Host command:', command);
  },
  onError(error) {
    console.error(error);
  },
});
```

The editor starts in Normal mode. Press `i` to type, `Esc` to return to Normal,
and `v` to extend selections. For example, `ec` selects to the end of the word
and enters Insert mode to replace it; `xd` selects a line and deletes it.

Import `monaco-helix/style.css` for the cursor, status, and prompt presentation.
If you omit the status element, the extension creates a status overlay inside
the editor. A supplied element keeps its existing content; the extension adds
and later removes its own child.

Attach one Helix instance per editor. Dispose it when switching to another
keymap. Attaching again to the same editor disposes its previous binding. The
extension does not create or dispose your Monaco models.

During view teardown, dispose the binding before the editor:

```ts
helix.dispose();
editor.dispose();
```

## API

`initHelixMode(editor, statusElement?, options?)` returns a `HelixBinding`.
The package exports the `HelixBinding`, `HelixOptions`, and `HelixMode` types.
`HelixMode` is `'normal' | 'insert' | 'select'`.

| Argument | Description |
| --- | --- |
| `editor` | A Monaco `IStandaloneCodeEditor` instance |
| `statusElement` | Optional existing element for the current mode and pending keys; omit or pass `undefined` for the default overlay |
| `options.onModeChange` | Callback receiving the initial `HelixMode`, later changes, and model resets |
| `options.onCommand` | Host command callback: `(command: string) => void \| Promise<void>` |
| `options.onError` | Error callback: `(error: Error) => void` |

The returned handle exposes:

| Method | Description |
| --- | --- |
| `getMode()` | Read the current mode |
| `onDidChangeMode(listener)` | Subscribe to future mode notifications; returns a disposable subscription |
| `dispose()` | Remove the extension's listeners, decorations, and UI |

Numeric colon commands such as `:42` go to that line. Other colon commands are
passed to `onCommand` without the leading colon for your application to handle.
Saving, closing files, and buffer switching depend on your host application.
Monaco language-service commands depend on providers registered by that
application. Clipboard operations require the browser's clipboard API and
permission.

Registers and the current search pattern belong to each binding, so separate
editors do not share them. They remain available when that editor changes
models; editing mode and pending input reset for the new model.

Insert mode uses Monaco's normal input, completion, and composition handling.
Normal and Select modes consume ordinary text keys to prevent accidental
insertion. Browser and operating-system shortcuts can still take precedence.

## Development

```sh
npm ci
npx playwright install chromium
npm run check
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for focused test commands and contribution
guidelines. Report reproducible problems through
[GitHub Issues](https://github.com/seo-rii/monaco-helix/issues).

## License

[MIT](LICENSE). Copyright © 2026 Seohyun Lee and Zixiao Laboratories.
