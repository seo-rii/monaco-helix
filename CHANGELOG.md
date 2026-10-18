# Changelog

## 0.2.0 — Configurable editing and optional syntax

- Add a shared command registry, `execute`, `listCommands`, `feedKeys`, and
  cancellation that protects later edits from failed or stale asynchronous work.
- Add surround removal/replacement, selection merging, inverse regex filters,
  cursors above, edits without yanking, and an injectable clipboard adapter.
- Support mode-specific keymaps, nested overrides, command arrays, Insert
  chords, logical key notation, atomic updates, and optional Helix TOML imports.
- Run regex search in interruptible Workers with bounded results, live previews,
  selection/viewport restoration, history, IME handling, and prefix help.
- Add `Q`/`q` recording and playback through `binding.macros`, including committed
  text, prompt responses, nested macros, shared budgets, and cancellation.
- Add jump history and optional host capabilities for file, buffer, symbol,
  and application commands with accessible pickers and stale-request guards.
- Add an optional syntax provider and Tree-sitter Worker for Python, C++, and
  TypeScript textobjects, structured selections, and object navigation.
- Ship pinned WASM assets with license notices and a hash manifest; validate the
  extracted package's exports, public types, and actual grammar parsing.
- Expand unit and Chromium integration coverage and publish feature guides.

## 0.1.0 — Initial source release

- Extract the Logos Helix controller and selection helpers into a standalone
  TypeScript ESM package for Monaco Editor.
- Provide `initHelixMode`, disposable status and prompt UI, mode events, and a
  host callback for application commands.
- Correct grapheme and paragraph boundaries, regex selection overlap, and
  boundary word motions; isolate each editor's registers and search state.
- Include a browser demo, selection unit tests, and Chromium integration tests.
- Preserve the upstream MIT license and document the source revision and review.

See [`docs/review.md`](docs/review.md) for review scope and implementation fixes.
