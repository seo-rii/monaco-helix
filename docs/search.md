# Search engine, history, and previews

Search uses JavaScript Unicode regular expressions rather than Helix's regex
engine. The core helpers are independent of Monaco and UI frameworks.

## Matching and limits

`findSearchMatches(text, pattern, options?)` returns
`{ matches: HelixSelection[], truncated: boolean }`. Ranges are half-open UTF-16
offsets. A match inside a combining sequence or joined emoji expands to the
whole grapheme; overlapping expanded matches are merged. Zero-width matches
stay empty and advance by a Unicode code point so they cannot loop forever.
An empty pattern produces no matches. Invalid patterns throw `SyntaxError`.

`SearchOptions` supports `caseSensitive` (default true), `multiline` (default
true), `maxMatches` (default 1000, maximum 10000), `maxDocumentLength` (default
2000000 UTF-16 units, maximum 10000000), and `maxPatternLength` (default 2000,
maximum 10000). Exceeding document/pattern limits throws `RangeError`; reaching
the result limit sets `truncated` when additional matches exist.

Optional `ranges` runs the pattern independently against selected substrings,
preserving input selection order and returning an additional `groups` array.
This preserves `^`/`$` semantics within a selection and distinguishes zero-width
matches at boundaries shared by adjacent selections. Scoped operations run as a
single worker request, with one global result cap and at most 10000 valid scopes.

This synchronous function is intended for tests, trusted short input, and worker
implementations. An output limit cannot interrupt one expensive regex match.
Do not execute untrusted patterns synchronously on an application's UI thread.

## Interruptible worker searches

`createWorkerSearchEngine({ timeoutMs?, workerFactory? })` returns an engine with
`search(text, pattern, searchOptions?, signal?)`, `cancel()`, and `dispose()`.
The default timeout is 500ms (bounded to 10–30000ms), including worker startup.
Each search runs in a fresh Worker which is terminated on success, failure,
timeout, cancellation, or supersession. Catastrophic regex backtracking is
therefore interruptible. A later search can still run after a timeout.

Cancellation rejects with `AbortError`; timeout and worker errors reject with
an `Error`. Regex errors retain their error name. There is no synchronous
fallback when Workers are unavailable, because it would remove the execution
budget. Dispose the engine with its owner.

The default implementation uses a Blob worker and revokes its URL on cleanup.
An application whose Content Security Policy disallows `blob:` workers can
provide `workerFactory: () => new Worker(/* application URL */)`. The worker
protocol is an input message `[text, pattern, options]` and an output message
`{ result: findSearchMatches(...) }` or
`{ error: { name: string, message: string } }`. The factory must return a fresh
worker each time. A bundled application worker can import `findSearchMatches`
to implement this protocol without duplicating the matching engine.

## Prompt history

`new SearchHistory(limit = 50)` stores nonempty patterns, deduplicated by most
recent use. Call `record(pattern)` after submission, `previous(currentDraft)`
for an Up action, and `next()` for Down. Moving back past the newest entry
restores the draft that was present before browsing history. `reset()` starts
a new browsing session; `values()` returns a copy. Limits are bounded to 1–1000.
This history is in-memory; persistence belongs to the application.

## Preview transactions

`SearchPreviewSession<T>` accepts `{ snapshot, restore, isCurrent? }`. Capture
the original directional selections, viewport, model URI, and version in the
snapshot. `update(operation, apply)` passes an abort signal to the operation
and applies only a current result, returning `true` when applied. A new update
cancels the previous one. Errors from canceled/stale operations are suppressed;
current errors propagate.

`accept()` keeps the preview and ends the session. `cancel()` restores the
original snapshot once. `dispose()` stops the session without restoring it.
`isCurrent()` must reject snapshots after model replacement, disposal, or
incompatible edits, so cancellation cannot restore selections into another
document. Even a provider that never resolves cannot hold a canceled update
open. The snapshot's contents remain the caller's responsibility.

Prompt integrations should debounce input, avoid submitting Enter during IME
composition, retain keyboard focus, label inputs and match counts for assistive
technology, and restore focus and viewport consistently on Escape. These UI
responsibilities are separate from the pure search helpers.

The built-in prompt applies these rules: previews debounce for 100ms, pending
work aborts as input changes, Up/Down browse history, and Escape or blur restores
the starting selections and scroll position. Composition input is left to the
IME until composition ends. Match counts are announced through a polite live
region. Model replacement/disposal and document-version changes invalidate
previews. Prefix key hints appear in a labeled region while a prefix is pending.

`HelixOptions.search` accepts `SearchConfiguration` (matching limits plus worker
timeout/factory). Search state and submitted-pattern history belong to a binding
and can survive model changes. Selection-regex operations reject truncated
results rather than silently returning an incomplete set to a later edit.
