# Implementation review

## Provenance and scope

The initial controller and selection helpers adapt `src/lib/helix.ts` and
`src/lib/helix-selection.ts` from
[zixiao-labs/logos at `69e08e1397cd0831a624183c171f129c0e293f61`](https://github.com/zixiao-labs/logos/tree/69e08e1397cd0831a624183c171f129c0e293f61).
The source is MIT-licensed, copyright 2026 Zixiao Laboratories; its license is
preserved in [LICENSE](../LICENSE) and
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Lifecycle integration also draws on upstream `src/lib/editor-keymap.ts`; the
standalone wrapper substantially reimplements it without application state or
framework dependencies.

The extraction review focuses on selection arithmetic, keyboard routing,
read-only protection, undo and insert state, asynchronous operations, model
switches, and resource disposal. It also checks that application-specific
commands are exposed through the host API rather than tied to Logos.

The review is scoped to this package and its pinned upstream source. It is not
a comprehensive audit of Logos or a claim of full Helix compatibility.

## Findings and changes

| Area | Finding and correction |
| --- | --- |
| Character boundaries | Offsets inside combining sequences, joined emoji, or CRLF could split a character. Selection and movement helpers now normalize to full grapheme boundaries, and backward movement clamps offsets beyond the document. |
| Word-motion boundaries | A motion that could not advance at the start or end of the document could shrink an existing selection. It now preserves that selection. |
| Backward search | `N` could select the current match again because it compared the match start to the cursor at the end of the selection. It now compares against the current selection's start. |
| Paragraph objects | Paragraph boundaries could produce a reversed range at a separator and missed whitespace-only blank lines. Blank-line groups and boundary ranges are handled explicitly. |
| Regex selections | Zero-width and partial matches could create positions inside graphemes or duplicate overlapping ranges. Matches are aligned to graphemes, deduplicated, and merged where they overlap. |
| Around text objects | Word and delimiter ranges could detach adjacent combining marks. Their boundaries now include complete graphemes. |
| Selection performance | Repeated movement recreated segmentation work for an unchanged document. A bounded cache reuses segmentation of the most recent text; enclosing-pair selection also avoids collecting and sorting all candidates. A long-document unit regression covers repeated movement. |
| Editor isolation | Upstream module-level registers and search state leaked between editors. Registers, search, and insertion history now belong to a binding and survive that editor's model switches. |
| Application coupling | Logos-specific language-action identifiers and application UI assumptions do not work in a standalone extension. This package uses Monaco actions, its own disposable status/prompt UI, and `onCommand` for host commands, with no React or Zustand dependency. |
| Lifecycle and asynchronous work | Controllers reset on model changes. Delayed clipboard operations check the captured model, revision, selections, and read-only state; pending history work is guarded against disposal and stale models. `Esc` also cancels a delayed clipboard read when the editor is already in Normal mode. |
| Reentrant mode callbacks | An initial `onModeChange` callback that changed models could leave nested controller listeners active after disposal. Initial notifications now occur after controller assignment, and callback delivery checks the active generation. |
| Prompt focus changes | Restoring focus before submitting a prompt can synchronously switch the model through host callbacks. The prompt now rechecks its generation after focus, so a stale command cannot target the replacement model. |
| Input and cleanup | Normal and Select modes guard native input as well as modal key events. Insert mode keeps Monaco's input path. Disposal removes owned resources and restores the editor options changed by the binding. |
| Reentrant disposal | Selection cleanup can invoke host cursor listeners that switch models or attach another binding. Disposal now marks the old binding inactive and detaches its listeners before cleanup, restores options before collapsing the selection, and preserves a newly attached binding. |
| Command ordering | Keyboard, public API, and keymap commands share one dispatcher. Asynchronous failures cancel queued edits. Cancellation detaches the old request before a new command starts, so a late response cannot clear a newer queue. |
| Configuration | Keymap replacements validate before installation. Nested overrides retain inherited prefix commands; incomplete Insert chords restore buffered text on timeout, mismatch, or composition start. |
| Search responsiveness | Regexes execute in terminable Workers with document, pattern, result, and time limits. Preview transactions restore the original selection and viewport on cancellation, and selection transforms reject truncated results. |
| Macro replay | Recordings distinguish logical keys, committed text, and prompt responses. Playback awaits asynchronous operations and uses shared recursion, step, cancellation, and model guards. |
| Host ownership | File and workbench operations require explicit host capabilities. Navigation records successful locations, aborts superseded requests, and keeps file/model ownership in the application. |
| Optional syntax | Parser work stays behind an optional provider and Worker entrypoint. Responses carry a document version and editor/model session ID, and stale, missing, or failed syntax selections cancel following edits. Runtime and grammar versions are pinned and shipped with licenses and hashes. |
| Native input ordering | Accepted regex searches enter the command queue. Native key streams wait for asynchronous selection work and resolve their bindings in the resulting mode, so a queued change followed by typing applies to the new selection. Failure, cancellation, and model changes discard buffered input; host shortcuts pass through immediately. |
| Initial configuration failure | If the initial controller rejects an invalid keymap or chord timeout, the wrapper disposes its partially attached binding and restores editor options and native input. |

These changes are package-specific fixes and adaptations. They do not establish
full equivalence with the native Helix editor.

## Validation

The initial extraction passed 24 selection unit cases and 36 Chromium integration
cases. The expanded suite additionally covers:

- Unicode and CRLF selection boundaries, directional ranges, text objects,
  surround edits, merging, and repeated long-document movement.
- Command cancellation, keymap validation, TOML imports, Worker regex limits,
  preview restoration, macro recursion, and host navigation races.
- Real Monaco keyboard/input routing, buffered native edits, undo, read-only
  behavior, prompts, model changes, reentrant callbacks, and disposal.
- Real Tree-sitter parsing, syntax selection order, version/language guards,
  independent editor sessions, and built Worker/WASM URL resolution.
- Type checking, a distribution build, and TypeScript consumers of the extracted
  npm package without the optional runtime installed.
- Shipped WASM hashes/licenses and actual parsing of extracted package assets.

`npm run check` runs the unit, type, package, and Chromium gates. Browser coverage
includes application-error collection rather than silently ignoring Worker
failures. Feature guides describe the tested behavior and compatibility limits.

## Compatibility boundaries

- The package targets Monaco Editor `^0.55.1`; compatibility with other Monaco
  versions requires validation.
- Unicode navigation uses the browser's `Intl.Segmenter` support.
- Regex commands use JavaScript's regex engine, so syntax and matching can
  differ from Helix.
- Clipboard operations depend on browser API availability and permission.
- Language actions rely on the host application's Monaco providers.
- Browser tests validate Chromium behavior; other browsers and operating-system
  shortcut interactions need additional testing.
- Automated tests do not establish complete input-method compatibility. Test
  the input methods used by your application before rollout.
