# Commands and host shortcuts

Keyboard commands and `binding.execute(id, args?)` share command handlers.
`binding.listCommands()` returns their identifiers, descriptions and mutation
flags. Editor command counts are truncated to integers and bounded to 1–10,000;
individual host capabilities may apply a smaller limit.

```ts
await helix.execute('select_all');
await helix.execute('change_selection');
```

Synchronous edits run immediately. The editor command queue serializes
asynchronous selection and clipboard operations. A failed asynchronous operation
cancels queued commands, so a following deletion cannot act on the previous
selection. Keymap command arrays also pause for missing character arguments and
interactive prompts; cancellation or a rejected submission discards their
remaining commands.

Native command input behind an asynchronous operation waits in a bounded queue
and uses the mode reached by preceding keys. For example, a pending search
followed by `chello` first selects the match, then changes it and inserts `hello`.
A fresh explicit mode-switch key can interrupt pending work; once input is
buffered, later keys continue that stream. Failure, Escape, model replacement, or
disposal drops waiting input. Host pass-through shortcuts remain immediate.
Actual IME composition is captured once Insert mode is active.

`helix.cancel()`, `Escape`, model replacement and disposal invalidate pending
editor work. A keyboard mode switch also cancels a pending clipboard operation.
Cancellation stops future edits and does not roll back completed edits or host
side effects. Pass an abort-aware host adapter for asynchronous application work;
the legacy `onCommand(command)` callback receives no cancellation signal.

Editor mutation commands reject in read-only editors. Application commands such
as a host save use the host's own read-only policy. Callers of `execute` receive
the error; keyboard errors are delivered through `onError`. Cancellation has the
standard `AbortError` name. Public navigation and picker commands use a
binding-owned host coordinator so intentional model navigation can complete;
model-bound keyboard and macro work still stops when the model changes.

`shouldHandleKey(event, mode)` may return false to preserve an application
shortcut. The host is responsible for handling the delegated shortcut and
preventing its native action when appropriate. Escape remains available for
cancellation. Modal text input guards remain active outside Insert mode.

Applications can inject `clipboard: { readText, writeText }`; otherwise the
browser Clipboard API is used. A completed read is applied only to the model,
selection revision and writable state that requested it.
