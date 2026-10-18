# Commands and host shortcuts

Keyboard commands and `binding.execute(id, args?)` share command handlers.
`binding.listCommands()` returns their identifiers, descriptions and mutation
flags. Counts are bounded to 10,000.

```ts
await helix.execute('select_all');
await helix.execute('change_selection');
```

Synchronous edits run immediately. An asynchronous selection or clipboard
operation delays later commands. A failed asynchronous operation cancels queued
commands, so a following deletion cannot act on the previous selection.
`helix.cancel()`, `Escape`, model replacement and disposal invalidate pending
work. A manual mode switch also cancels a pending clipboard operation.

Mutation commands reject in read-only editors. Callers of `execute` receive the
error; keyboard errors are delivered through `onError`. Cancellation has the
standard `AbortError` name.

`shouldHandleKey(event, mode)` may return false to preserve an application
shortcut. The host is responsible for handling the delegated shortcut and
preventing its native action when appropriate. Escape remains available for
cancellation. Modal text input guards remain active outside Insert mode.

Applications can inject `clipboard: { readText, writeText }`; otherwise the
browser Clipboard API is used. A completed read is applied only to the model,
selection revision and writable state that requested it.
