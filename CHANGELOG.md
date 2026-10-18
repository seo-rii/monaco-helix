# Changelog

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
