// Copyright (c) 2026 Zixiao Laboratories
// SPDX-License-Identifier: MIT
// Adapted from Logos' helix-selection.test.ts; additional regression coverage.

import { describe, expect, it, vi } from "vitest";
import {
  characterSelection, cursorOf, moveSelection, nextChar, previousChar,
  regexSelections, selectionBounds, textObject, wordSelection,
  type HelixSelection,
} from "../src/selection.js";

const selectedText = (text: string, range: HelixSelection) => text.slice(...selectionBounds(range));
const all = (text: string): HelixSelection[] => [{ anchor: 0, head: text.length }];

describe("grapheme selections", () => {
  it("keeps surrogate pairs, combining marks, joined emoji and CRLF intact", () => {
    const text = "a👩‍💻é\r\n中";
    expect(nextChar(text, 1)).toBe(6);
    expect(previousChar(text, 6)).toBe(1);
    expect(nextChar(text, 6)).toBe(8);
    expect(nextChar(text, 8)).toBe(10);
    expect(cursorOf(text, { anchor: 1, head: 6 })).toBe(1);
  });

  it("snaps every offset inside a grapheme to the complete character", () => {
    const text = "a👩‍💻é\r\n中";
    const boundaries = [0, 1, 6, 8, 10, 11];
    for (let index = 0; index < boundaries.length - 1; index++) {
      const start = boundaries[index]!;
      const end = boundaries[index + 1]!;
      for (let offset = start; offset < end; offset++) {
        expect(characterSelection(text, offset)).toEqual({ anchor: start, head: end });
        expect(cursorOf(text, { anchor: end, head: offset })).toBe(start);
      }
    }
  });

  it("clamps offsets and safely handles empty documents and EOF cursors", () => {
    expect(previousChar("abc", 100)).toBe(2);
    expect(previousChar("abc", -20)).toBe(0);
    expect(nextChar("abc", -20)).toBe(1);
    expect(nextChar("abc", 100)).toBe(3);
    expect(characterSelection("", 20)).toEqual({ anchor: 0, head: 0 });
    expect(characterSelection("abc", 100)).toEqual({ anchor: 3, head: 3 });
    expect(cursorOf("", { anchor: 0, head: 0 })).toBe(0);
    expect(previousChar("", 0)).toBe(0);
    expect(nextChar("", 0)).toBe(0);
  });

  it("extends selections across the anchor without losing a character", () => {
    const text = "a👩‍💻éz";
    const initial = characterSelection(text, 6);
    const backwards = moveSelection(text, initial, 2, true);
    expect(backwards).toEqual({ anchor: 8, head: 1 });
    expect(moveSelection(text, backwards, 8, true)).toEqual({ anchor: 6, head: 9 });
    expect(moveSelection(text, backwards, 3, false)).toEqual({ anchor: 1, head: 6 });
  });

  it("handles an empty extend selection at EOF", () => {
    expect(moveSelection("a👩‍💻", { anchor: 6, head: 6 }, 2, true))
      .toEqual({ anchor: 6, head: 1 });
    expect(moveSelection("", { anchor: 0, head: 0 }, 0, true))
      .toEqual({ anchor: 0, head: 0 });
  });
});

describe("word motions", () => {
  it("selects trailing whitespace with w and stops before it with e", () => {
    const text = "alpha beta.gamma";
    const start = characterSelection(text, 0);
    const w = wordSelection(text, start, "w", 1, false);
    expect(selectedText(text, w)).toBe("alpha ");
    expect(selectedText(text, wordSelection(text, w, "w", 1, false))).toBe("beta");
    expect(selectedText(text, wordSelection(text, start, "e", 1, false))).toBe("alpha");
    expect(wordSelection(text, characterSelection(text, 6), "b", 1, false).head).toBe(0);
  });

  it("treats punctuation as a word boundary except for uppercase motions", () => {
    const text = "one.two next";
    expect(selectedText(text, wordSelection(text, characterSelection(text, 0), "w", 1, false))).toBe("one");
    expect(selectedText(text, wordSelection(text, characterSelection(text, 0), "W", 1, false))).toBe("one.two ");
    expect(selectedText(text, wordSelection(text, characterSelection(text, 6), "B", 1, false))).toBe("one.two");
  });

  it("moves counts to the final word, matching repeated Helix motions", () => {
    const text = "alpha beta gamma delta";
    for (const motion of ["w", "e", "b", "W", "E", "B"]) {
      const initial = characterSelection(text, motion.toLowerCase() === "b" ? 17 : 0);
      let repeated = initial;
      for (let n = 0; n < 3; n++) repeated = wordSelection(text, repeated, motion, 1, false);
      expect(wordSelection(text, initial, motion, 3, false)).toEqual(repeated);
    }
  });

  it("keeps the original anchor when extending multiple words backwards", () => {
    const text = "alpha beta gamma";
    const range = characterSelection(text, 11);
    const result = wordSelection(text, range, "b", 2, true);
    expect(result).toEqual({ anchor: 12, head: 0 });
    expect(selectedText(text, result)).toBe("alpha beta g");
  });

  it("preserves an existing selection when a motion cannot advance", () => {
    const forward = { anchor: 0, head: 3 };
    const backward = { anchor: 3, head: 0 };
    expect(wordSelection("abc", forward, "w", 1, false)).toEqual(forward);
    expect(wordSelection("abc", forward, "e", 1, false)).toEqual(forward);
    expect(wordSelection("abc", backward, "b", 1, false)).toEqual(backward);
    for (const motion of ["w", "e", "b"]) {
      expect(wordSelection("", { anchor: 0, head: 0 }, motion, 10, false)).toEqual({ anchor: 0, head: 0 });
    }
  });

  it("moves over Unicode words without splitting their graphemes", () => {
    const text = "한글 éx👩‍💻";
    const first = wordSelection(text, characterSelection(text, 0), "w", 1, false);
    expect(selectedText(text, first)).toBe("한글 ");
    const second = wordSelection(text, characterSelection(text, 3), "e", 1, false);
    expect(selectedText(text, second)).toBe("éx");
  });

  it("segments a long unchanged document once while moving through it", () => {
    const text = "performance_" + "a".repeat(50_000) + " end";
    const spy = vi.spyOn(Intl.Segmenter.prototype, "segment");
    try {
      const result = wordSelection(text, { anchor: 0, head: 1 }, "w", 1, false);
      expect(result.head).toBe(text.length - 3);
      expect(spy.mock.calls.filter(([input]) => input === text)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("text objects", () => {
  it("selects the smallest enclosing pair and accepts either delimiter", () => {
    const text = "call(one, (two))";
    expect(textObject(text, characterSelection(text, 12), "(", false)).toEqual({ anchor: 11, head: 14 });
    expect(textObject(text, characterSelection(text, 12), ")", true)).toEqual({ anchor: 10, head: 15 });
    expect(textObject(text, characterSelection(text, 8), "(", false)).toEqual({ anchor: 5, head: 15 });
    expect(textObject("()", characterSelection("()", 0), "(", false)).toEqual({ anchor: 1, head: 1 });
    expect(textObject("((x)", characterSelection("((x)", 2), "(", true)).toEqual({ anchor: 1, head: 4 });
    expect(textObject("abc", characterSelection("abc", 1), "(", false)).toBeNull();
    expect(textObject("abc", characterSelection("abc", 1), "unknown", false)).toBeNull();
  });

  it("distinguishes escaped quotes from delimiters after even backslashes", () => {
    const text = '"a\\"b" "c\\\\"';
    const first = textObject(text, characterSelection(text, 3), '"', false)!;
    expect(selectedText(text, first)).toBe('a\\"b');
    const second = textObject(text, characterSelection(text, 9), '"', false)!;
    expect(selectedText(text, second)).toBe('c\\\\');
  });

  it("does not cut combining marks off delimiters or adjacent whitespace", () => {
    const text = "(́a)́";
    expect(textObject(text, characterSelection(text, 2), "(", false)).toEqual({ anchor: 2, head: 3 });
    expect(textObject(text, characterSelection(text, 2), "(", true)).toEqual({ anchor: 0, head: 5 });
    const spaced = "alpha ́beta";
    const word = textObject(spaced, characterSelection(spaced, 0), "w", true)!;
    expect(selectedText(spaced, word)).toBe("alpha ́");
  });

  it("selects Unicode words, and prefers trailing whitespace for around word", () => {
    const text = "  한글_name.next";
    expect(textObject(text, characterSelection(text, 4), "w", false)).toEqual({ anchor: 2, head: 9 });
    expect(textObject(text, characterSelection(text, 4), "W", true)).toEqual({ anchor: 0, head: text.length });
    expect(textObject("alpha beta", characterSelection("alpha beta", 2), "w", true)).toEqual({ anchor: 0, head: 6 });
    expect(textObject("", { anchor: 0, head: 0 }, "w", false)).toEqual({ anchor: 0, head: 0 });
  });

  for (const eol of ["\n", "\r\n"]) {
    it(`selects paragraphs and blank-line groups with ${JSON.stringify(eol)} endings`, () => {
      const paragraphs = [`first${eol}line`, "middle", "last"];
      const separator = eol + eol;
      const text = paragraphs.join(separator);
      let offset = 0;
      for (const [index, paragraph] of paragraphs.entries()) {
        const range = characterSelection(text, offset + 1);
        expect(textObject(text, range, "p", false)).toEqual({ anchor: offset, head: offset + paragraph.length });
        expect(textObject(text, range, "p", true)).toEqual({
          anchor: offset,
          head: offset + paragraph.length + (index < paragraphs.length - 1 ? separator.length : 0),
        });
        offset += paragraph.length + separator.length;
      }
      const blanks = `first${eol} \t${eol}${eol}last`;
      const gapStart = "first".length;
      const gapEnd = blanks.length - "last".length;
      for (let cursor = gapStart; cursor < gapEnd; cursor++) {
        const range = textObject(blanks, characterSelection(blanks, cursor), "p", false)!;
        expect(range).toEqual({ anchor: gapStart, head: gapEnd });
      }
      expect(textObject(blanks, characterSelection(blanks, blanks.length - 1), "p", false)).toEqual({
        anchor: gapEnd, head: blanks.length,
      });
    });
  }
});

describe("regex selections", () => {
  it("selects matches and splits selections in either direction", () => {
    const text = "foo, bar, foo";
    for (const ranges of [all(text), [{ anchor: text.length, head: 0 }]]) {
      expect(regexSelections(text, ranges, "foo", false)).toEqual([{ anchor: 0, head: 3 }, { anchor: 10, head: 13 }]);
      expect(regexSelections(text, ranges, ", ", true)).toEqual([{ anchor: 0, head: 3 }, { anchor: 5, head: 8 }, { anchor: 10, head: 13 }]);
    }
  });

  it("searches each range independently and preserves absolute offsets", () => {
    expect(regexSelections("foo  foo  foo", [{ anchor: 5, head: 8 }, { anchor: 10, head: 13 }], "foo", false))
      .toEqual([{ anchor: 5, head: 8 }, { anchor: 10, head: 13 }]);
    expect(regexSelections("xfoo", [{ anchor: 1, head: 4 }], "^foo$", false))
      .toEqual([{ anchor: 1, head: 4 }]);
  });

  it("advances empty matches and keeps their cursors at grapheme boundaries", () => {
    const text = "é👩‍💻\r\n";
    expect(regexSelections(text, all(text), "", false)).toEqual([
      { anchor: 0, head: 0 }, { anchor: 2, head: 2 },
      { anchor: 7, head: 7 }, { anchor: 9, head: 9 },
    ]);
    expect(regexSelections(text, all(text), "", true)).toEqual([
      { anchor: 0, head: 2 }, { anchor: 2, head: 7 }, { anchor: 7, head: 9 },
    ]);
    expect(regexSelections("", all(""), "", false)).toEqual([{ anchor: 0, head: 0 }]);
    expect(regexSelections("", all(""), "x", false)).toEqual([]);
  });

  it("expands partial matches without duplicating or overlapping characters", () => {
    const text = "é👩‍💻";
    expect(regexSelections(text, all(text), ".", false)).toEqual([
      { anchor: 0, head: 2 }, { anchor: 2, head: 7 },
    ]);
    expect(regexSelections("aéb", all("aéb"), ".{2}", false))
      .toEqual([{ anchor: 0, head: 4 }]);
    expect(regexSelections("é", all("é"), "e|(?=́)", false))
      .toEqual([{ anchor: 0, head: 2 }]);
  });

  it("splits CRLF and combining characters atomically", () => {
    expect(regexSelections("a\r\nb", all("a\r\nb"), "\\r", true))
      .toEqual([{ anchor: 0, head: 1 }, { anchor: 3, head: 4 }]);
    expect(regexSelections("aéb", all("aéb"), "́", true))
      .toEqual([{ anchor: 0, head: 1 }, { anchor: 3, head: 4 }]);
  });

  it("throws malformed patterns without changing the supplied selections", () => {
    const ranges = all("foo");
    const before = structuredClone(ranges);
    expect(() => regexSelections("foo", ranges, "[", false)).toThrow(SyntaxError);
    expect(ranges).toEqual(before);
    expect(regexSelections("foo", ranges, "(?=o)", false)).toEqual([
      { anchor: 1, head: 1 }, { anchor: 2, head: 2 },
    ]);
  });
});
