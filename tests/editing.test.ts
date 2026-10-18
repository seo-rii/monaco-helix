import { describe, expect, it } from "vitest";
import { mergeConsecutiveSelections, mergeSelections, surroundEdits, type TextEdit } from "../src/editing.js";
import { characterSelection } from "../src/selection.js";

function apply(text: string, edits: TextEdit[]): string {
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return text;
}
const at = (text: string, ...offsets: number[]) => offsets.map(offset => characterSelection(text, offset));

describe("surround editing", () => {
  it("removes matched brackets from either delimiter and replaces with paired delimiters", () => {
    const text = "before (hello) after";
    expect(apply(text, surroundEdits(text, at(text, 9), "("))).toBe("before hello after");
    expect(apply(text, surroundEdits(text, at(text, 9), ")", "]"))).toBe("before [hello] after");
    expect(apply(text, surroundEdits(text, at(text, 9), "(", "👩‍💻"))).toBe("before 👩‍💻hello👩‍💻 after");
  });

  it("supports escaped quotes and only removes their actual enclosing pair", () => {
    const text = 'say "a\\"b" now';
    expect(apply(text, surroundEdits(text, at(text, 7), '"'))).toBe('say a\\"b now');
    expect(apply(text, surroundEdits(text, at(text, 7), '"', "'"))).toBe("say 'a\\\"b' now");
  });

  it("deduplicates shared pairs and edits nested pairs in one nonoverlapping transaction", () => {
    const text = "((a)b)";
    const edits = surroundEdits(text, at(text, 2, 2, 4), "(", "[");
    expect(edits).toHaveLength(4);
    for (let index = 1; index < edits.length; index++) expect(edits[index]!.start).toBeGreaterThanOrEqual(edits[index - 1]!.end);
    expect(apply(text, edits)).toBe("[[a]b]");
  });

  it("handles empty pairs, backwards selections, multiple lines and CRLF intact", () => {
    expect(apply("()", surroundEdits("()", at("()", 1), "("))).toBe("");
    const text = "(한글\r\n👩‍💻)";
    expect(apply(text, surroundEdits(text, [{ anchor: text.length - 1, head: 1 }], "(", "{"))).toBe("{한글\r\n👩‍💻}");
  });

  it("removes whole delimiter graphemes without stranding combining marks", () => {
    const text = "(́hello)́";
    const edits = surroundEdits(text, at(text, 4), "(");
    expect(edits).toEqual([{ start: 0, end: 2, text: "" }, { start: 7, end: 9, text: "" }]);
    expect(apply(text, edits)).toBe("hello");
  });

  it("ignores unsupported, missing, invalid and out-of-range surrounds", () => {
    const text = "(hello)";
    expect(surroundEdits(text, at(text, 3), "[", "(")).toEqual([]);
    expect(surroundEdits(text, at(text, 3), "unknown")).toEqual([]);
    expect(surroundEdits(text, at(text, 3), "(", "two")).toEqual([]);
    expect(surroundEdits(text, at(text, 3), "(", "")).toEqual([]);
    expect(surroundEdits(text, at(text, 3), "(", "\r\n")).toEqual([]);
    expect(surroundEdits("(hello", at("(hello", 3), "(")).toEqual([]);
    expect(surroundEdits(text, [{ anchor: NaN, head: 2 }], "(")).toEqual([]);
    expect(surroundEdits(text, [{ anchor: -1, head: 2 }], "(")).toEqual([]);
    expect(surroundEdits(text, [{ anchor: 100, head: 2 }], "(")).toEqual([]);
  });
});

describe("selection merging", () => {
  it("spans every range while preserving a backwards primary and leaving inputs intact", () => {
    const ranges = [{ anchor: 9, head: 7 }, { anchor: 1, head: 3 }, { anchor: 5, head: 5 }];
    expect(mergeSelections(ranges)).toEqual([{ anchor: 9, head: 1 }]);
    expect(ranges[0]).toEqual({ anchor: 9, head: 7 });
    expect(mergeSelections([])).toEqual([]);
  });

  it("merges touching, overlapping and duplicate empty ranges transitively", () => {
    const ranges = [{ anchor: 5, head: 8 }, { anchor: 1, head: 3 }, { anchor: 3, head: 6 }, { anchor: 8, head: 8 }];
    expect(mergeConsecutiveSelections(ranges)).toEqual([{ anchor: 1, head: 8 }]);
    expect(mergeConsecutiveSelections([{ anchor: 2, head: 2 }, { anchor: 2, head: 2 }])).toEqual([{ anchor: 2, head: 2 }]);
  });

  it("retains primary group ordering and its direction independently of document order", () => {
    const ranges = [{ anchor: 12, head: 10 }, { anchor: 1, head: 3 }, { anchor: 8, head: 10 }, { anchor: 4, head: 7 }];
    expect(mergeConsecutiveSelections(ranges)).toEqual([
      { anchor: 12, head: 8 }, { anchor: 1, head: 3 }, { anchor: 4, head: 7 },
    ]);
    expect(mergeConsecutiveSelections([])).toEqual([]);
  });
});
