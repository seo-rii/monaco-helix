# Macros

`Q` starts or stops recording and `q` replays the selected macro register.
The default macro register is `@`; `"aQ` records to `a` and `"aq` plays it.
Numeric prefixes repeat the entire macro. These controls follow
[Helix's macro bindings](https://docs.helix-editor.com/keymap.html#changes).

Recorded keys pass through the current keymap again during replay. Changing a
binding can therefore change what an existing key macro does. A command array
such as `['open_below', 'normal_mode']` directly invokes command IDs instead.
Use command arrays for stable application actions and key macros for Helix-style
keyboard workflows.

## Monaco binding

Each binding exposes `binding.macros`, an independent `MacroEngine` with completed
registers that survive Monaco model changes. A model switch cancels playback and
discards an unfinished recording. Disposing the binding releases its registers.
Use `binding.cancel()` or `binding.macros.cancel()` to stop playback; native editor
input, Escape, and enabling read-only mode also cancel active playback.

```ts
binding.macros.set('a', [
  { type: 'key', key: 'i' },
  { type: 'text', text: 'Hello' },
  { type: 'key', key: 'esc' },
]);
await binding.execute('replay_macro', { register: 'a', count: 2 });
// Equivalent direct playback:
await binding.macros.play('a', 2);
```

The binding records ordinary Insert input and committed composition text, rather
than duplicating both printable key presses and their resulting text. Insert
movement, deletion, tab and newline commands retain their key events. Playing a
register during recording records the invocation once, without expanding its
generated events. Prompt responses are structured events, so a key-only stream
that opens a prompt cannot silently continue editing the old selection.

The automated Chromium tests cover native typing, Unicode insertion, and the
composition event protocol. Real operating-system IME behavior still depends on
the browser, input method and Monaco version; test the target environment when
shipping an IME-sensitive integration.

## Input and asynchronous work

The macro event format contains normalized keys, committed text, prompt responses,
and explicit nested register calls. IME composition updates are not committed
input and must not be recorded as repeated insertions. A browser host records the
final text, including Unicode graphemes, after composition completes. Prompt
events can carry the prompt prefix and whether submission was cancelled. Replay
validates the active prompt and awaits the submitted action. A missing response,
cancelled prompt, or rejected submission stops subsequent events. Command arrays
also pause when a prompt opens: remaining commands run only after successful
submission and completion of the interactive command. This prevents a sequence
such as `['search', 'delete_selection']` from deleting the previous selection.

Playback awaits each injected operation. Clipboard reads and application commands
must finish before the next step executes. Hosts receive an `AbortSignal` and
must check it, along with their model/session guards, before applying an
asynchronous result. Cancellation ends playback promptly even if a host promise
never settles; it cannot undo a side effect that a host already completed.

Normal command and Insert-session undo boundaries remain meaningful during
playback. The macro engine does not call undo, create a document transaction, or
roll back host side effects. The Monaco binding owns those editing rules. `.`
continues to mean the last insertion; macro repetition is controlled by `q`.

## Standalone recorder and player

`MacroEngine` requires no Monaco or DOM objects. It executes structured events
through an injected function and never dispatches synthetic browser input:

```ts
const macros = new MacroEngine({
  async execute(event, signal, context) {
    if (event.type === 'key') await host.feedKey(event.key, signal, context);
    if (event.type === 'text') await host.insertText(event.text, signal);
    if (event.type === 'prompt') await host.answerPrompt(event, signal);
  },
});

macros.start('a');
macros.record({ type: 'key', key: 'i' });
macros.record({ type: 'text', text: '한글👩‍💻' });
macros.record({ type: 'key', key: 'esc' });
macros.stop();
await macros.play('a', 2);
```

The caller omits the start/stop control keys when invoking `record()`. Completed
recordings replace their register atomically. `discard()` abandons an unfinished
recording while keeping the previous completed value. Playback-generated input
is not re-recorded, so playing another register during recording does not expand
its generated input into the recording.

`set(register, events)` imports a structured event list; `get()` returns a copy.
`set(register, 'miw')` imports a pure Helix key stream. `getKeys()` exports only a
pure key stream and throws `not_key_macro` for committed-text, prompt, or explicit
nested-replay events. Such browser extensions must be stored using their event
list rather than silently converted to a purported Helix-compatible string.

## Nested playback and cancellation

An executor can await `context.play(register, count)` when a replayed key resolves
to another macro, or `context.playKeys(keys, count)` for an inline key stream.
The binding uses this shared context for `@...` keymap macros too. Explicit `{ type: 'replay', register: 'b', count: 2 }` events do
the same thing. Sibling nested requests execute in order, and the engine waits
for them even if the executor forgets to return the child promise. Calling the
top-level `play()` while another playback is active reports `busy`.

The defaults are 100,000 total events, 32 nested macro calls, and a browser
yield every 128 events. All nested calls and repetition counts share the event
budget. Counts must be integers between 0 and 10,000. Direct and indirect register
or inline-key recursion is rejected. `playKeys(keys, count, options)` provides the
same limits for standalone inline playback. Limits and the yield function are
configurable when constructing a standalone `MacroEngine`; the Monaco binding
uses the defaults.

Use `cancel()` or an external `AbortSignal` to interrupt replay. Cancellation
rejects the playback promise with an `AbortError` whose code is `cancelled`.
Executor errors reject that promise and invalidate child work. A failed playback
clears its playing state so another macro can run. `dispose()` cancels playback,
discards recording, and releases stored registers. Host lifecycle handlers should
cancel before switching models or disposing the editor.

```ts
const cancellation = new AbortController();
const playback = macros.play('a', 3, { signal: cancellation.signal });
cancellation.abort();
await playback.catch(error => {
  if (error.name !== 'AbortError') throw error;
});
```

Register contents and returned events are snapshots. Replacing a register while
it is playing affects the next call, not the current playback. Status callback
failures are isolated and can be observed using the engine's `onError` callback.
