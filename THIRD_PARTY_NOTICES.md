# Third-party notices

## Logos

The Helix controller and selection helpers in this package are adapted from
[zixiao-labs/logos](https://github.com/zixiao-labs/logos), specifically
[commit `69e08e1397cd0831a624183c171f129c0e293f61`](https://github.com/zixiao-labs/logos/tree/69e08e1397cd0831a624183c171f129c0e293f61).
The controller and selection helpers originate in `src/lib/helix.ts` and
`src/lib/helix-selection.ts`. Lifecycle integration also draws on
`src/lib/editor-keymap.ts`, with a substantially reimplemented standalone
wrapper. Upstream `src/lib/helix-selection.test.ts`,
`e2e/editor-keymap.e2e.test.tsx`, and `docs/editor/modal-editing.md` informed this
project's tests and documentation. This package extracts the implementation
from the Logos application, provides a standalone Monaco API, and includes its
own fixes and integration code.

Logos is distributed under the MIT License. Its copyright and permission notice
are retained below and in this project's [LICENSE](LICENSE).

```text
MIT License

Copyright (c) 2026 Zixiao Laboratories

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Monaco Editor

[`monaco-editor`](https://github.com/microsoft/monaco-editor) is a peer dependency
provided by the consuming application. It is distributed by Microsoft under the
MIT License. Consult its distribution for its license and third-party notices.

## TOML parser

The optional `monaco-helix/toml` entrypoint imports
[`smol-toml`](https://github.com/squirrelchat/smol-toml), distributed separately
as an npm dependency under the BSD 3-Clause License. Copyright belongs to
Squirrel Chat et al. Its distribution retains the full license text.

## Optional Tree-sitter runtime and grammar assets

The build copies the WASM runtime from `web-tree-sitter` **0.25.10** (MIT) and
three prebuilt grammar binaries from `tree-sitter-wasms` **0.1.13** (Unlicense).
The grammar projects retain their own MIT notices:

| Grammar | Copyright | License source |
| --- | --- | --- |
| Python | 2016 Max Brunsfeld | [tree-sitter-python v0.21.0](https://github.com/tree-sitter/tree-sitter-python/blob/v0.21.0/LICENSE) |
| C++ | 2014 Max Brunsfeld | [tree-sitter-cpp v0.20.4](https://github.com/tree-sitter/tree-sitter-cpp/blob/v0.20.4/LICENSE) |
| TypeScript | 2017 GitHub | [tree-sitter-typescript v0.20.5](https://github.com/tree-sitter/tree-sitter-typescript/blob/v0.20.5/LICENSE) |

The source tags above identify the license notices; the prebuilt package's
declared source ranges do not identify exact grammar source commits. The lockfile
pins the prebuilt tarball. The generated `dist/syntax-assets/manifest.json`
records each shipped binary's byte length and SHA-256 hash.

The distributed assets include `dist/syntax-assets/LICENSES.txt`, containing the
runtime and prebuilt package's license texts plus the three grammar notices.
See the [asset copy script](scripts/copy-syntax-assets.mjs) and
[syntax deployment guide](docs/syntax.md). The textobject queries in this
package are original implementations of the documented capture contract.
