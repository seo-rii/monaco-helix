import { nextChar, previousChar, selectionBounds, textObject, type HelixSelection } from "./selection.js";

/** Half-open UTF-16 replacement. Apply a complete returned set in one transaction. */
export interface TextEdit { start: number; end: number; text: string }

const pairs: Readonly<Record<string, string>> = {
  "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "`": "`",
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function replacementPair(value: string): [string, string] | undefined {
  if (!value || /[\r\n]/u.test(value)) return undefined;
  const parts = graphemes.segment(value)[Symbol.iterator]();
  if (parts.next().done || !parts.next().done) return undefined;
  if (Object.hasOwn(pairs, value)) return [value, pairs[value]!];
  const opening = Object.keys(pairs).find(key => pairs[key] === value);
  return opening ? [opening, value] : [value, value];
}

/**
 * Remove (to omitted) or replace enclosing ASCII brackets/quotes.
 * Invalid inputs and unmatched pairs are no-ops. All offsets preserve graphemes.
 */
export function surroundEdits(
  text: string,
  ranges: readonly HelixSelection[],
  from: string,
  to?: string,
): TextEdit[] {
  if (!(Object.hasOwn(pairs, from) || Object.values(pairs).includes(from))) return [];
  const replacement = to === undefined ? ["", ""] : replacementPair(to);
  if (!replacement) return [];
  const edits: TextEdit[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    if (!Number.isInteger(range.anchor) || !Number.isInteger(range.head)
      || range.anchor < 0 || range.head < 0 || range.anchor > text.length || range.head > text.length) continue;
    const outer = textObject(text, range, from, true);
    if (!outer) continue;
    const [start, end] = selectionBounds(outer);
    const identity = `${start}:${end}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const openingEnd = nextChar(text, start);
    const closingStart = previousChar(text, end);
    // An unusual combined delimiter cluster cannot be edited twice atomically.
    if (openingEnd > closingStart) continue;
    const candidate: TextEdit[] = [
      { start, end: openingEnd, text: replacement[0]! },
      { start: closingStart, end, text: replacement[1]! },
    ];
    // Keep each pair atomic; partially accepting a conflict could corrupt syntax.
    if (candidate.some(edit => edits.some(accepted => edit.start < accepted.end && accepted.start < edit.end))) continue;
    edits.push(...candidate);
  }
  return edits.sort((left, right) => left.start - right.start || left.end - right.end);
}

/** Span all selections while keeping the primary selection's direction. */
export function mergeSelections(ranges: readonly HelixSelection[]): HelixSelection[] {
  if (!ranges.length) return [];
  let start = Infinity;
  let end = -Infinity;
  for (const range of ranges) {
    const [from, to] = selectionBounds(range);
    start = Math.min(start, from);
    end = Math.max(end, to);
  }
  return [ranges[0]!.anchor > ranges[0]!.head ? { anchor: end, head: start } : { anchor: start, head: end }];
}

/** Merge overlapping/touching groups; preserve each group's earliest selection as primary. */
export function mergeConsecutiveSelections(ranges: readonly HelixSelection[]): HelixSelection[] {
  const sorted = ranges.map((range, index) => {
    const [start, end] = selectionBounds(range);
    return { start, end, index, backwards: range.anchor > range.head };
  }).sort((left, right) => left.start - right.start || left.end - right.end || left.index - right.index);
  const groups: typeof sorted = [];
  for (const range of sorted) {
    const previous = groups.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      if (range.index < previous.index) {
        previous.index = range.index;
        previous.backwards = range.backwards;
      }
    } else groups.push({ ...range });
  }
  return groups.sort((left, right) => left.index - right.index).map(range => range.backwards
    ? { anchor: range.end, head: range.start } : { anchor: range.start, head: range.end });
}
