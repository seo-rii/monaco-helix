# Optional syntax editing

The core entrypoint does not load a syntax parser. Import `monaco-helix/tree-sitter`
only when you want syntax textobjects, structured selection, and movement.
The adapter lazily creates one module Worker and loads grammars on first use.
Python, C++, and TypeScript have original textobject queries included here.

```ts
import { createTreeSitterProvider } from 'monaco-helix/tree-sitter';

const syntax = createTreeSitterProvider();
const helix = initHelixMode(editor, undefined, { syntaxProvider: syntax });

// A provider can serve multiple editors. Bindings release their model sessions;
// the host owns the shared provider's final lifetime.
helix.dispose();
syntax.dispose();
```

## Deployment and self hosting

The package includes `dist/syntax-worker.js` and `dist/syntax-assets/`, containing
the runtime WASM, three grammar WASM files, a SHA-256 provenance manifest, and
their license notices. No public CDN or external service is contacted.
Your bundler must process module workers and preserve or copy their WASM assets.
For an explicit deployment, copy `monaco-helix/syntax-assets/*` to a static
directory and pass `assetBaseUrl`. It should be an absolute URL, or a root-relative
URL resolved against the application's origin; a relative path is resolved
against the adapter module. For example, Vite can bundle an explicit Worker
entry with its `?worker` import:

```ts
import SyntaxWorker from 'monaco-helix/syntax-worker?worker';

const syntax = createTreeSitterProvider({
  assetBaseUrl: new URL('/editor-syntax/', window.location.origin).href,
  workerFactory: () => new SyntaxWorker(),
});
```

Worker URL handling differs between bundlers. A host can instead serve a bundled
module Worker at a fixed URL and return `new Worker('/syntax-worker.js',
{ type: 'module' })`. Serve WASM as `application/wasm` and allow your own Worker
and WASM URLs under the application's Content Security Policy.

The adapter resolves individual packaged WASM file URLs in its main module and
sends the complete absolute configuration to the Worker. It does not infer asset
directories from a generated Worker URL or rely on directory URL rewriting.

The browser suite also imports the built `dist/tree-sitter.js` with no overrides
and parses all shipped languages through its default Worker and asset URLs.
Run `npm run build` before running browser tests directly; `npm run check`
builds the distribution before that gate.

`web-tree-sitter` is optional and pinned to **0.25.10**. The verified grammar
artifacts come from **tree-sitter-wasms 0.1.13**. The copy script rejects another
pair, and records binary hashes and the upstream package's declared grammar
source ranges. Those source ranges do not identify exact grammar commits;
the pinned tarball and hashes identify the shipped artifacts. Runtime and grammar
upgrades must repeat actual parsing tests for all three languages.

Grammar MIT notices retain the upstream copyright and full license text, checked
against [Python v0.21.0](https://github.com/tree-sitter/tree-sitter-python/blob/v0.21.0/LICENSE),
[C++ v0.20.4](https://github.com/tree-sitter/tree-sitter-cpp/blob/v0.20.4/LICENSE),
and [TypeScript v0.20.5](https://github.com/tree-sitter/tree-sitter-typescript/blob/v0.20.5/LICENSE).
Those are the declared minimum source versions in the pinned prebuilt package.
They establish license notice provenance; they do not identify the prebuilt
binaries' exact source commits. The manifest records those notice URLs separately
from binary hashes. The runtime's own MIT notice and the prebuilt package's own
Unlicense are also included in `LICENSES.txt`.

## Supported syntax objects

| Object | Python | C++ | TypeScript |
| --- | --- | --- | --- |
| Function | `def`, including async/nested functions, lambdas | Function definitions, lambdas | Function declarations/expressions, generators, arrows, methods |
| Type/class | Classes | Classes and structs | Classes, interfaces, type aliases |
| Argument/parameter | Function parameters and call arguments | Parameter declarations and call arguments | Required/optional parameters and call arguments |
| Comment | `#` comments | Line/block comments | Line/block comments |
| Test | Functions named `test_*` | No framework-specific query | Calls named `test`, `it`, or `describe` |

Inside function/type selection selects the body with brace delimiters removed;
Python's indentation-based body keeps its source indentation. Inside comments
excludes comment delimiters. Around argument selection includes an adjacent
comma and horizontal whitespace when available. Unsupported objects or missing
semantic targets return no result for the entire selection set, canceling any
queued edit rather than letting it change an older selection. Movement at a
boundary leaves the selection unchanged. Unsupported languages return no result;
ordinary word/paragraph/surround objects work independently.

Queries use Helix's `function`, `class`, `parameter`, `comment`, and `test`
capture names with `.inside`, `.around`, and optional `.movement` suffixes.
Movement prefers `.movement`, then `.around`, then `.inside`.
This is a documented subset of Helix semantics, rather than a copy of Helix's
runtime queries. Language injections, JSX/TSX grammars, framework-specific C++
tests, and custom Helix query predicates are not implied by TypeScript/C++
support. Unknown custom predicates are rejected rather than silently ignored.
See [Helix's query contract](https://docs.helix-editor.com/guides/textobject.html).

Pass `languages` to add another grammar and optional query, replace a built-in,
or disable one by assigning `undefined`. Keys use Monaco language IDs (`python`,
`cpp`, and `typescript` for the built-ins); the document ID `c++` also aliases
`cpp`. If you replace a built-in entry, include its query explicitly when you
want semantic objects: `languages: { python: { wasm: pythonUrl,
query: treeSitterQueries.python } }`. Grammar-only entries retain structural
tree navigation. Custom language ownership, grammar ABI compatibility, query
compatibility, and license notices belong to the host application.

The provider supports enclosing-object counts, previous/next object movement,
parent expansion, shrinking, previous/next siblings, all siblings/children, and
movement to parent boundaries. Parent expansion stores up to 100 previous
selection sets so shrinking can restore exact extent and direction. A document
edit resets that expansion history.

| Keys | Command |
| --- | --- |
| `mi` / `ma` + `f`, `t`, `a`, `c`, `T` | Select inside/around function, type, argument, comment, test |
| `Alt-o`, `Alt-Up` | Expand to parent syntax node |
| `Alt-i`, `Alt-Down` | Shrink, restoring an earlier expansion when available |
| `Alt-p` / `Alt-n`, `Alt-Left` / `Alt-Right` | Previous/next named sibling |
| `Alt-a` / `Alt-I` | Select all named siblings/children |
| `Alt-b` / `Alt-e` | Move to the start/end of the parent node |
| `]` / `[` + `f`, `t`, `a`, `c`, `T` | Move to the next/previous corresponding object |

These commands require `options.syntaxProvider`. Ordinary word, paragraph, and
surround textobjects keep their existing parser-free implementation. Syntax
navigation extends the selection in Select mode; semantic object selection
replaces it. Commands typed after an asynchronous selection wait for it; a failed
selection cancels those queued edits. `Esc` cancels pending syntax requests.

## Provider API and correctness

`monaco-helix/syntax` exports the provider contract and `SyntaxCoordinator`.
Document snapshots contain a stable editor/model session ID, model version, language ID, and
immutable text. Give separate editors distinct session IDs even when they show
the same Monaco model, so their expansion history remains independent.
Requests contain an operation, all selections, and an
`AbortSignal`. Results repeat the model version. Coordinates are directional,
half-open **UTF-16 offsets**, like Monaco; they are not UTF-8 bytes or grapheme
counts. `SyntaxCoordinator` rejects stale responses and invalid ranges, and
expands a partial grapheme result to safe boundaries.

The official Tree-sitter C API describes byte coordinates, but the pinned web
binding converts JavaScript-facing indices and columns to UTF-16 code units.
Do not apply another UTF-8 conversion to its output. The tests parse after emoji,
Korean, and CRLF to verify this contract. A custom UTF-8 provider must perform its
own conversion at the provider boundary.

Every model has a separate parser/tree. Requests are processed serially. The
adapter incrementally edits the old tree using the single enclosing replacement
between old/new snapshots before parsing the current snapshot. This also safely
represents multiple disjoint Monaco edits and undo without assuming the event's
coordinate order. The broader replacement can reduce incremental reuse compared
with individual edits, but avoids applying an edit in the wrong document space.
Model-language changes create a fresh parser. Releasing a model invalidates any
queued requests for that model.

The coordinator cancels an older request when a new one starts, and never
applies a result from a canceled operation. The binding must additionally check
its active Monaco model and selection revision before applying a result. It must
also preserve command ordering: a `d` typed after `mif` must wait for successful
selection rather than deleting the previous selection if parsing fails.

## Budgets and lifetime

Defaults are 2,000,000 UTF-16 code units per document, eight resident model
sessions, a 500 ms parse/query budget, and a 10 second Worker request deadline
(including cold loading). Options can change each limit. Large documents return
no result. Inactive model sessions are evicted in least-recently-used order.
Queries cap concurrent matches and result selections at 10,000. An exceeded
parse/query/selection budget rejects with an error identifying the phase,
elapsed time, and configured limit (`SyntaxBudgetError` in the inline engine;
the Worker forwards its message). A query match-limit failure also rejects. Missing
semantic objects and unsupported languages still return no result. The command
dispatcher cancels queued edits for both missing results and parser errors.

Cancellation discards results immediately. A Worker cannot receive an abort
message while synchronous WASM is running, so parsing/query progress callbacks
and time budgets bound that computation. Exceeding the outer request deadline
terminates the Worker and rejects outstanding requests; the next request starts
a fresh Worker. Parser progress callbacks are periodic, so the inner budget is
a cooperative limit, not a hard realtime guarantee.

The default includes headroom for a cold WASM parser and scheduler pauses. A
100 ms wall-clock limit was observed to reject a tiny first C++ parse under
browser load even though its syntax tree and Unicode ranges were valid. Hosts
can choose a tighter `parseTimeoutMs`; explicit timeout tests remain enabled.

`release(modelId)` explicitly frees a model's tree/parser. `dispose()` terminates
the default Worker and settles pending requests. The inline engine deletes its
trees/parsers/queries on dispose. The shared WASM runtime and loaded language
modules remain alive for their JavaScript realm; an inline host needing complete
memory reclamation should run it inside a disposable Worker. Inline mode is
available for Node and applications that already own a worker:

```ts
import { createTreeSitterProvider, treeSitterQueries } from 'monaco-helix/tree-sitter';

const syntax = createTreeSitterProvider({
  execution: 'inline',
  wasmUrl: '/absolute/path/to/tree-sitter.wasm',
  languages: { python: { wasm: '/absolute/path/to/tree-sitter-python.wasm',
    query: treeSitterQueries.python } },
});
```

Use the exported `treeSitterQueries` when replacing a built-in grammar URL.
A language without a query supports tree navigation but has no semantic objects.
The query and runtime API are optional entrypoints; importing core Helix mode
does not import `web-tree-sitter` or start a Worker.
