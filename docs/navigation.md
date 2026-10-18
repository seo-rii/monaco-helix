# Navigation and host integration

The extension owns modal editing and its bounded jump history. Your application
owns files, Monaco models, language providers, tabs, windows, saving, and closing.
Navigation never creates or disposes a model itself.

## Location snapshots

`NavigationLocation` is serializable and contains a URI, directional UTF-16
`selections`, an optional model `version`, and optional `viewport` scroll offsets.
The history copies these fields so callers cannot accidentally mutate an entry.
Selection direction and the primary selection's order are retained.

`NavigationHistory` defaults to 100 entries, configurable through its constructor
(`limit`, bounded to 2–1000). Record the initial location and completed jumps with
`record(location)`. Consecutive duplicate URI/selections update their version and
viewport without consuming another history entry. A new jump after going back
replaces the forward branch. `snapshot()` returns independent copies.

`back(openLocation)` and `forward(openLocation)` update the history cursor only
after the host accepts the destination. `navigate(location, openLocation)` adds a
new accepted destination; record its source before calling it. All three return
`Promise<boolean>` and accept an optional `AbortSignal`.

Use `updateCurrent(location)` before traversal when ordinary cursor motion has
changed the current entry. It refreshes the position without dropping forward
history. `record(location)` deliberately creates a new jump branch. Both travel
methods accept a count after the optional signal and clamp it to available
history, so a large count goes directly to the earliest/latest entry.

An opener receives a location and `{ signal, requestId, reason }`, where reason
is `navigate`, `back`, or `forward`. Return:

- `false` when the file/model is unavailable, closed, or cannot be opened.
- Nothing when the requested location was applied successfully.
- The actual `NavigationLocation` when positions needed clamping after edits.

Current host errors are propagated; cancellations and stale responses return
`false`. Failed destinations remain in history so a temporarily unavailable file
can be retried. No automatic file recreation occurs.

## Host capabilities

`HostAdapter` has optional capabilities:

| Capability | Responsibility |
| --- | --- |
| `listBuffers(query, context)` | List the host's existing open buffers |
| `queryFiles(query, context)` | Search files visible to the host |
| `querySymbols(query, context)` | Query symbols through host language services |
| `openLocation(location, context)` | Open/focus a destination and apply its view |
| `executeCommand(command, context)` | Execute host commands such as saving or moving windows |

Picker methods return `HostItem[]`: each item has `id`, `label`, optional
`description`, and optional `location` or `command`. An unsupported capability
should be omitted. The extension has no built-in workspace index, disk access,
LSP server, shell execution, or dirty-file confirmation policy.

Every context has an `AbortSignal`. Before changing a model, editor, or focus
after an asynchronous operation, the host **must check the signal again**. The
package suppresses stale results, but cannot undo external effects a host has
already performed. A jump requested by the extension may intentionally switch
models: the host's integration must distinguish this committed navigation from
an unrelated external model change when canceling old requests.

On a disposed model, either resolve the URI through host-owned resources and
return its current location, or return `false`. Use the version as a hint and
validate every offset against the actual model before applying it. Saving or
closing decisions, including unsaved-change prompts, belong to the host.
Read-only navigation is permitted; mutating commands must respect host policy.
Snapshots retain offsets rather than rebasing through intervening edits; the
host may return a corrected location when clamping alone would be insufficient.

## Request lifetime

`HostRequestController` provides the same cancellation rules for custom pickers:
`run(reason, operation, signal?)` returns `{ value }` for a current result and
`undefined` when canceled. A new operation cancels the previous one. `cancel()`
and `dispose()` settle pending callers even if a provider ignores its signal;
late provider failures are consumed. Cancel on external model/editor changes and
dispose the controller with its owner. `NavigationHistory` applies these rules
internally and drops all entries on disposal.

## Binding integration

`HelixOptions.host` supplies the capabilities above. Optional `navigation`
settings configure `historyLimit` (default 100, 2–1000) and `pickerLimit` (default
100, 1–1000). File, buffer, and symbol pickers send the current query and abort
superseded requests; duplicate IDs and results past the configured cap are
excluded. Picker rendering uses a keyboard-accessible listbox. Unsupported
capabilities produce an explicit error instead of assuming a filesystem.
Escape cancels an interactive picker with `AbortError`. Unavailable selected
destinations reject as failures. Both stop any queued macro or keymap-array edits
so they cannot run against the selection that preceded the picker.

| Command | Default key |
| --- | --- |
| `jump_backward` | `Ctrl-o` |
| `jump_forward` | `Ctrl-i` |
| `file_picker` | `Space f` |
| `buffer_picker` | `Space b` |
| `symbol_picker` | `Space s` |
| `host_command` | `:` prompt; arguments contain `command` |

These commands also work through `binding.execute(id, args?)`. A public
navigation call resolves after an intentional model change has completed.
Keyboard commands and macros still cancel their old model's pending work when
the model changes.

The existing `onCommand` callback takes priority for application commands,
including `binding.execute('host_command', { command: 'write' })`. When it is
absent, `host.executeCommand` handles the command with an abortable context.
The host implements aliases such as `w`/`write` and owns save/close confirmation.
Numeric colon commands such as `:42` go to a local line and record a jump.
Legacy `onCommand` has no cancellation parameter; prefer the host capability
when asynchronous external work needs an `AbortSignal`.

Picker macro responses store `{ query, selectedId }` as their prompt value.
Replay queries the host again and requires that exact ID in the current result;
it rejects missing targets instead of silently choosing another entry. Cross-model
navigation still cancels the old model's macro playback. Keep item IDs stable
for reliable same-model symbol and workbench command replay.

Jump history belongs to the binding and survives model changes. Ordinary cursor
motion refreshes the current position when traveling without creating a new
jump or losing forward entries. File/line jumps and accepted searches record
their source/destination through the controller bridge. A search preview records
nothing until submission; Escape restores its original position. Locations in
the active model work without a host opener, with offsets clamped to the current
document and expanded to complete graphemes. Host workbench commands execute
only through the supplied capability.

For cross-model navigation, `openLocation` must open the requested URI in the
bound editor and check cancellation before committing asynchronous work. It may
return corrected selection/viewport data for that URI. The binding distinguishes
this expected model change from an unrelated external switch: the navigation
transaction can finish, while the old model controller's queued edits and macros
are canceled. Unexpected switches, editor teardown, and explicit binding
cancellation abort outstanding host work and prevent stale history commits.

The internal `createHostController` helper isolates this lifecycle. Its
`onModelChange()` must run before disposing the old model controller; it retains
the last pre-switch location and marks expected navigation commits. It retains
serializable snapshots only and does not dispose host models on teardown.
