// Copyright (c) 2026 Zixiao Laboratories
// SPDX-License-Identifier: MIT
// Adapted from Logos' helix-selection.ts with grapheme and boundary fixes.

/** Helix ranges are directional, half-open UTF-16 offsets (like Monaco). */
export interface HelixSelection {
  anchor: number;
  head: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Constructing Segments copies/scans the input on some engines. Retain only the
// latest immutable document, rather than constructing it for every moved char.
let segmented: { text: string; segments: Intl.Segments } | undefined;

function segmentAt(text: string, offset: number): Intl.SegmentData | undefined {
  if (segmented?.text !== text) segmented = { text, segments: graphemes.segment(text) };
  return segmented.segments.containing(offset);
}

function clampOffset(text: string, offset: number): number {
  return Math.min(text.length, Math.max(0, Math.trunc(offset) || 0));
}

function characterStart(text: string, offset: number): number {
  const position = clampOffset(text, offset);
  return position === text.length ? position : segmentAt(text, position)?.index ?? position;
}

export function nextChar(text: string, offset: number): number {
  offset = clampOffset(text, offset);
  if (offset >= text.length) return text.length;
  const part = segmentAt(text, offset);
  return part ? part.index + part.segment.length : text.length;
}

export function previousChar(text: string, offset: number): number {
  offset = clampOffset(text, offset);
  return offset > 0 ? segmentAt(text, offset - 1)?.index ?? 0 : 0;
}

export function cursorOf(text: string, range: HelixSelection): number {
  return range.head > range.anchor ? previousChar(text, range.head) : characterStart(text, range.head);
}

export function characterSelection(text: string, offset: number): HelixSelection {
  const head = characterStart(text, offset);
  return { anchor: head, head: nextChar(text, head) };
}

export function moveSelection(
  text: string,
  range: HelixSelection,
  position: number,
  extend: boolean,
): HelixSelection {
  if (!extend) return characterSelection(text, position);
  position = characterStart(text, position);
  const anchor = range.anchor > range.head
    ? previousChar(text, range.anchor)
    : characterStart(text, range.anchor);
  return position < anchor
    ? { anchor: nextChar(text, anchor), head: position }
    : { anchor, head: nextChar(text, position) };
}

function category(char: string, long: boolean): number {
  if (/\s/u.test(char)) return 0;
  return long || /[\p{L}\p{N}\p{M}_]/u.test(char) ? 1 : 2;
}

/** Word motions select up to a boundary; repeated motions start a new range. */
export function wordSelection(
  text: string,
  range: HelixSelection,
  motion: string,
  count: number,
  extend: boolean,
): HelixSelection {
  const backwards = motion.toLowerCase() === "b";
  const end = motion.toLowerCase() === "e";
  const long = motion === motion.toUpperCase();
  if (count <= 0 || Number.isNaN(count)
    || (backwards ? range.head === 0 : range.head === text.length)) return range;
  let head = backwards ? cursorOf(text, range) : nextChar(text, cursorOf(text, range));
  let anchor = backwards ? nextChar(text, head) : cursorOf(text, range);
  const boundary = (left: string, right: string) => {
    const a = category(left, long);
    const b = category(right, long);
    return a !== b && (end ? a !== 0 : b !== 0);
  };
  for (let step = 0; step < count; step++) {
    const initial = head;
    while (backwards ? head > 0 : head < text.length) {
      const left = text.slice(previousChar(text, head), head);
      const right = text.slice(head, nextChar(text, head));
      if (boundary(left, right)) {
        if (head === initial) anchor = head;
        else break;
      }
      head = backwards ? previousChar(text, head) : nextChar(text, head);
    }
    // Large counts must stop at the document boundary rather than spending time
    // repeating a motion that cannot advance (including an infinite count).
    if (head === initial) break;
  }
  if (extend) {
    const target = backwards ? head : previousChar(text, head);
    return moveSelection(text, range, target, true);
  }
  return head === anchor ? characterSelection(text, head) : { anchor, head };
}

export function selectionBounds(range: HelixSelection): [number, number] {
  return [Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)];
}

export function textObject(
  text: string,
  range: HelixSelection,
  object: string,
  around: boolean,
): HelixSelection | null {
  const cursor = cursorOf(text, range);
  let start = cursor;
  let end = nextChar(text, cursor);
  if (object === "w" || object === "W") {
    const kind = category(text.slice(cursor, end), object === "W");
    while (start > 0) {
      const prev = previousChar(text, start);
      if (category(text.slice(prev, start), object === "W") !== kind) break;
      start = prev;
    }
    while (end < text.length && category(text.slice(end, nextChar(text, end)), object === "W") === kind) {
      end = nextChar(text, end);
    }
    if (around && kind !== 0) {
      const before = end;
      while (end < text.length && /^[ \t]/u.test(text.slice(end, nextChar(text, end)))) {
        end = nextChar(text, end);
      }
      if (end === before) {
        while (start > 0 && /^[ \t]/u.test(text.slice(previousChar(text, start), start))) {
          start = previousChar(text, start);
        }
      }
    }
    return { anchor: start, head: end };
  }
  if (object === "p") {
    start = 0;
    end = text.length;
    const separator = /\r?\n(?:[ \t]*\r?\n)+/g;
    for (let match; (match = separator.exec(text));) {
      const after = match.index + match[0].length;
      if (cursor >= after) start = after;
      else if (cursor >= match.index) {
        // A cursor on the blank-line group selects that whitespace paragraph;
        // never construct an inverted range at the first separator character.
        return { anchor: match.index, head: after };
      } else {
        end = around ? after : match.index;
        break;
      }
    }
    return { anchor: start, head: end };
  }
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "`": "`" };
  const open = Object.hasOwn(pairs, object) ? object : Object.keys(pairs).find(key => pairs[key] === object);
  if (!open) return null;
  const close = pairs[open];
  const stack: number[] = [];
  let pair: [number, number] | undefined;
  for (let index = 0; index < text.length; index++) {
    // An odd number of preceding backslashes escapes a quote.
    if (open === close && text[index] === open) {
      let slashes = 0;
      for (let p = index - 1; p >= 0 && text[p] === "\\"; p--) slashes++;
      if (slashes % 2) continue;
      if (stack.length) {
        const from = stack.pop()!;
        if (from <= cursor && cursor <= index && (!pair || index - from < pair[1] - pair[0])) pair = [from, index];
      }
      else stack.push(index);
    } else if (text[index] === open) stack.push(index);
    else if (text[index] === close && stack.length) {
      const from = stack.pop()!;
      if (from <= cursor && cursor <= index && (!pair || index - from < pair[1] - pair[0])) pair = [from, index];
    }
  }
  return pair ? {
    anchor: around ? characterStart(text, pair[0]) : nextChar(text, pair[0]),
    head: around ? nextChar(text, pair[1]) : characterStart(text, pair[1]),
  } : null;
}

export function regexSelections(
  text: string,
  ranges: HelixSelection[],
  pattern: string,
  split: boolean,
): HelixSelection[] {
  const regex = new RegExp(pattern, "gmu");
  const result: HelixSelection[] = [];
  for (const range of ranges) {
    const [rawStart, rawEnd] = selectionBounds(range);
    const start = characterStart(text, rawStart);
    const endStart = characterStart(text, rawEnd);
    const end = rawStart === rawEnd || endStart === clampOffset(text, rawEnd)
      ? endStart : nextChar(text, endStart);
    const selected = text.slice(start, end);
    const firstResult = result.length;
    let previous = start;
    for (const match of selected.matchAll(regex)) {
      const from = characterStart(text, start + match.index);
      const rawTo = start + match.index + match[0].length;
      const toStart = characterStart(text, rawTo);
      const to = match[0].length === 0 || toStart === rawTo ? toStart : nextChar(text, toStart);
      if (split) {
        if (previous < from) result.push({ anchor: previous, head: from });
        previous = Math.max(previous, to);
      } else {
        const last = result.length > firstResult ? result[result.length - 1] : undefined;
        // Regexes operate on code points. Expand a partial grapheme match, then
        // coalesce duplicates/overlaps so edits cannot cut or edit it twice.
        if (last && (from < last.head || (from === last.anchor && from === last.head))) {
          last.head = Math.max(last.head, to);
        } else result.push({ anchor: from, head: to });
      }
    }
    if (split && previous < end) result.push({ anchor: previous, head: end });
  }
  return result;
}
