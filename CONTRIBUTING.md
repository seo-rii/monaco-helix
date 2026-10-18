# Contributing

Bug reports, focused fixes, and improvements to Helix behavior are welcome.
For a larger feature, open an issue first so its scope and expected behavior can
be discussed.

## Development

Use Node.js 22.12 or later and npm.

```sh
git clone https://github.com/seo-rii/monaco-helix.git
cd monaco-helix
npm ci
npx playwright install chromium
npm run check
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the browser demo locally |
| `npm test` | Run the selection-helper unit tests |
| `npm run test:browser` | Run Monaco integration tests in Chromium |
| `npm run typecheck` | Check TypeScript types |
| `npm run build` | Build the distributable package |
| `npm run check` | Run the project's validation checks |

## Changes and tests

Keep changes focused on one behavior. For a bug fix, include a regression test
with the starting document, selections, key sequence, and expected result.
Selection arithmetic belongs in the unit tests; keyboard routing, undo groups,
model changes, disposal, and read-only behavior need browser coverage against
real Monaco. Browser tests should send DOM keyboard events rather than call
private controller methods.

Check both forward and backward selections when changing selection behavior.
Consider empty models, end of file, CRLF, combining marks, emoji, multiple
selections, and read-only editors where relevant. Preserve ordinary Monaco
input and composition behavior in Insert mode.

Document a new public option in the README and new key bindings in
[`docs/keymap.md`](docs/keymap.md). Note user-visible changes in
[`CHANGELOG.md`](CHANGELOG.md). Use a conventional commit subject such as
`fix: preserve selections when switching models`.

## Upstream provenance

This project adapts MIT-licensed code from
[zixiao-labs/logos](https://github.com/zixiao-labs/logos). Keep its attribution and
license notices when changing or moving derived code. If a change incorporates
more upstream code, record the source and commit in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Contributions are provided under this repository's [MIT License](LICENSE).
