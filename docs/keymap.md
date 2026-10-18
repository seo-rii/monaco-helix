# Supported keymap

This document describes the bindings implemented by `monaco-helix`. The
[Helix keymap](https://docs.helix-editor.com/keymap.html) is a useful reference
for the selection-first model; this package implements a subset.

Keys are case-sensitive: `w` and `W` are different commands. A sequence such as
`miw` means press `m`, then `i`, then `w`. Most motions accept a numeric prefix,
such as `3j` or `2w`. `Esc` cancels an incomplete sequence and returns to Normal
mode. Counts are bounded to 10,000.

## Modes and movement

| Keys | Action |
| --- | --- |
| `Esc`, `Ctrl-[` | Return to Normal mode; cancel pending keys |
| `i`, `a` | Enter Insert mode before or after the selection |
| `v` | Toggle Select mode |
| `h`, `j`, `k`, `l`; arrow keys | Move left, down, up, right |
| `w`, `b`, `e` | Move by word |
| `W`, `B`, `E` | Move by whitespace-delimited word |
| `Home`, `End` | Move to the line start or end |
| `gg`, `ge` | Go to the first or last line |
| `20gg`, `20G` | Go to line 20 |
| `gh`, `gl`, `gs` | Go to the line start, end, or first non-whitespace character |
| `g\|` | Go to the column given by the count |
| `f`, `t`, `F`, `T` + character | Find or move till a character, forward or backward |
| `Alt-.` | Repeat the last character find |
| `Ctrl-b`, `Ctrl-f`; `PageUp`, `PageDown` | Move a page up or down |
| `Ctrl-u`, `Ctrl-d` | Move half a page up or down |

In Select mode, motions extend the current selections.

## Selections

| Keys | Action |
| --- | --- |
| `x`, `X` | Select or extend lines |
| `%` | Select the whole document |
| `;` | Collapse selections to the cursor character |
| `Alt-;` | Reverse selection direction |
| `_` | Trim whitespace from selections |
| `C` | Add selections on the next line |
| `,` | Keep only the primary selection |
| `(`, `)` | Rotate the primary selection |
| `s` | Select regex matches within the current selections |
| `S` | Split current selections on a regex |
| `K` | Keep selections matching a regex |
| `Alt-s` | Split selections into lines |
| `mi`, `ma` + object | Select inside or around a text object |
| `ms` + character | Surround selections with the character or matching brackets |
| `mm` | Jump to the matching bracket through Monaco |

Text objects include `w`, `W`, `p`, brackets, and quotes. Regex prompts use
JavaScript regular expressions, not Helix's regex engine. Submit a prompt with
`Enter` or cancel with `Esc`.

## Editing

| Keys | Action |
| --- | --- |
| `d` | Yank and delete selections |
| `c` | Change selections and enter Insert mode |
| `y` | Yank selections |
| `p`, `P` | Paste after or before selections |
| `R` | Replace selections with register contents |
| `"` + register | Choose a register for the next operation |
| `Space y`, `Space p`, `Space P` | Yank or paste through the system clipboard |
| `I`, `A` | Insert at the start or end of the line |
| `o`, `O` | Open a new line below or above |
| `r` + character | Replace selected characters |
| `~`, `` ` `` | Toggle case or make lowercase |
| `u`, `U` | Undo or redo |
| `Ctrl-z`, `Ctrl-Shift-z` | Undo or redo |
| `.` | Repeat the last insertion |
| `>`, `<` | Indent or outdent selected lines |
| `=` | Format selections through Monaco |
| `J` | Join lines through Monaco |
| `Ctrl-c` | Toggle line comments through Monaco |

`.` repeats the last insertion entry and inserted text. It does not replay
arbitrary commands performed during an insertion. Read-only editors allow
navigation, selection, search, and yanking while rejecting edit commands.

## Search and application commands

| Keys | Action |
| --- | --- |
| `/`, `?` | Prompt for a forward or backward regex search |
| `n`, `N` | Find the next or previous match |
| `*` | Use the primary selection as a literal search pattern |
| `:` | Prompt for a line number or host application command |
| `gd`, `gy`, `gr`, `gi` | Monaco definition, type definition, references, implementation |
| `Space k` | Show hover |
| `Space r` | Rename through Monaco |
| `Space a` | Show quick fixes through Monaco |

In Select mode, `n` and `N` add matches to the selections. Language-service
commands require the corresponding Monaco providers. A numeric command such as
`:42` goes to line 42. Other colon commands, such as `:w`, have no built-in
filesystem behavior; connect `onCommand` to your host application.

## Scope

Helix configuration files, custom keymaps, macros, shell pipelines, tree-sitter
syntax text objects, and window management are outside the current feature
set. Registers and search behavior are implemented in JavaScript; this package
does not embed the Helix editor. See the [review notes](review.md) for known
limitations and validation scope.
