# Surround and selection helpers

`surroundEdits(text, ranges, from, to?)` returns nonoverlapping, ascending
`{ start, end, text }` edits in half-open UTF-16 offsets. Omit `to` to remove a
surround; supply it to replace the surround. Apply the complete returned set in
one Monaco edit transaction so the operation has one undo step.

Supported existing surrounds are `()`, `[]`, `{}`, `<>`, double quotes, single
quotes, and backticks. Either side of a bracket pair can identify it. A
replacement is one grapheme: known brackets produce their matching pair, and
other characters such as quotes or emoji use the same character on both sides.
Empty, multiline, and multi-grapheme replacements are no-ops. Unsupported or
unmatched existing surrounds also produce no edits.

The helper uses the existing text-object matcher: it chooses the innermost
enclosing pair at each selection's cursor, and respects escaped quotes. It is
lexical rather than syntax-aware; language-specific strings, comments, and
template interpolation require a syntax provider. Delimiter removal and
replacement preserve complete graphemes, including combining marks, while
leaving document content and CRLF line endings inside the surround intact.

Selections addressing the same pair edit it once. Multiple nested pairs are
allowed when their delimiter edits are disjoint. If unusual grapheme boundaries
would make delimiter edits overlap, the conflicting pair is skipped as a whole;
one side is never applied on its own. No input selection or text is mutated.

`mergeSelections(ranges)` returns one range spanning every selection. Its
direction follows the original primary selection (`ranges[0]`).
`mergeConsecutiveSelections(ranges)` merges overlapping or immediately touching
ranges, including duplicate cursors. Each group's direction follows its earliest
original selection, and groups retain that original selection order so the
primary group remains first. Both helpers return new ranges, accept empty lists,
and expect valid finite document offsets supplied by the editor integration.
