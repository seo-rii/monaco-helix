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
