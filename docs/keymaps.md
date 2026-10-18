# Custom keymaps

Custom bindings use the same command IDs as `binding.execute()` and
`binding.listCommands()`. A keymap has separate `normal`, `insert`, and `select`
tables. Nested tables form multi-key prefixes; arrays run commands in order.

```ts
const binding = initHelixMode(editor, status, {
  keymap: {
    normal: {
      'C-s': ':write',
      g: { a: 'code_action' },
      ret: ['open_below', 'normal_mode'],
      'C-ret': 'pass_through',
      'A-x': '@miw',
    },
    insert: { j: { k: 'normal_mode' } },
  },
  onCommand: command => app.runCommand(command),
});
```

`setKeymap()` replaces the previous override set; it does not accumulate changes.
Nested overrides preserve other inherited prefix bindings. Replacing a prefix
with a command removes its old descendants. Replacing a command with a nested
table makes that key a prefix. An empty override set restores the defaults.
An invalid replacement leaves the currently installed map intact.

Three values have different purposes:

| Value | Meaning |
| --- | --- |
| `null` | Remove an inherited binding. The engine returns an explicit unbound result. |
| `'no_op'` | Consume the binding without performing an action. |
| `'pass_through'` | Delegate the event to Monaco or the host. |

Keys in Normal/Select that have no editing command still follow the binding's
modal input policy. `null` does not mean `pass_through`. Hosts should use an
explicit pass-through rule to preserve their shortcuts.

## Key notation

Use `C-`, `A-`, `S-`, and `Cmd-` for Control, Alt, Shift, and Command/Meta.
`Ctrl-`, `Control-`, `Alt-`, `Shift-`, `Meta-`, `Win-`, and `Super-` are accepted
aliases. Modifier order is normalized. Letter case is significant: `w` and `W`
are different keys; `C-S-k` and `C-K` name the same modified key.

Named keys include `esc`, `ret`, `space`, `tab`, `backspace`, `del`, `ins`,
`left`, `right`, `up`, `down`, `home`, `end`, `pageup`, `pagedown`, and `f1`
through `f35`. Browser names such as `Escape`, `Enter`, and `ArrowLeft` also
normalize to these names. Write a modified minus as `A-minus`, not `A--`.
Shifted ASCII punctuation normalizes to its produced character, for example
`C-S-1` becomes `C-!` and `A-S-minus` becomes `A-_`.

`keyFromEvent()` ignores composition and AltGraph. Alt-letter and Alt-punctuation
shortcuts use `KeyboardEvent.code` to retain their physical key on macOS, where
Option can produce alternate glyphs. Unmodified text uses `KeyboardEvent.key`.
This is a browser keyboard convention; unusual keyboard layouts should supply
bindings matching their normalized input.

Macro bindings start with `@`. `@miw` replays `m`, `i`, `w`; named and modified
keys are enclosed in angle brackets, such as `@ihello<esc>` or `@x<A-d>`.
Write literal `<` as `<lt>`. `decodeKeys()` and `encodeKeys()` expose the same
notation. A macro or pass-through binding must stand alone rather than appear
inside a command array. Colon commands are delegated to `onCommand`.

## TOML import

The optional TOML entrypoint parses a configuration string without reading files
or loading a parser in the core entrypoint:

```ts
import { importKeymapToml } from 'monaco-helix/toml';

const imported = importKeymapToml(configText, {
  commands: binding.listCommands().map(command => command.id),
});
if (imported.ok) binding.setKeymap(imported.keymap);
else showDiagnostics(imported.diagnostics);
```

Only `[keys.normal]`, `[keys.insert]`, and `[keys.select]` are imported. Other
sections, such as `theme` and `[editor]`, produce warnings and are ignored.
Unknown command IDs produce errors when `commands` is supplied. Static command
names, colon commands, command arrays, nested tables, and standalone `@` macros
are supported. Helix commands requiring a shell, filesystem, tree-sitter, or a
workbench still require corresponding host capabilities. Importing a file does
not add those capabilities.

TOML has no `null`; use JavaScript overrides for explicit deletion. Use `no_op`
to disable a binding in TOML. Parse errors include the parser's source location;
validation errors identify the affected key path. The importer rejects unsafe
prototype keys and non-table keymap values.

## Standalone engine

`KeymapEngine` can be used without Monaco or a DOM:

```ts
const engine = new KeymapEngine(defaults, { commands: supportedCommandIds });
const update = engine.replace(overrides);
if (update.ok) {
  const match = engine.lookup('normal', ['g', 'a']);
  // commands, macro, pass, pending, or unbound
}
const help = engine.list('normal', ['g']);
```

The engine owns validation and immutable lookup tables, while the caller owns
prefix buffering and timeout policy. `revision` changes only after a successful
replacement, so callers can discard a pending prefix when configuration changes.
Returned command arrays and help entries are independent snapshots.
