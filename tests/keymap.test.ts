import { describe, expect, it } from "vitest";
import { decodeKeys, encodeKeys, KeymapEngine, KeymapError, keyFromEvent, normalizeKey, type Keymaps } from "../src/keymap.js";
import { applyKeymapToml, importKeymapToml } from "../src/toml.js";

describe("Helix key notation", () => {
  it.each([
    ["Escape", "esc"], ["Enter", "ret"], ["ArrowLeft", "left"],
    ["Ctrl-s", "C-s"], ["Meta-s", "Cmd-s"], ["Win-s", "Cmd-s"],
    ["A-C-x", "C-A-x"], ["C-S-k", "C-S-k"], ["C-K", "C-S-k"],
    ["S-k", "K"], ["K", "K"], ["k", "k"], ["C-S-esc", "C-S-esc"],
    ["A-minus", "A-minus"], ["S-minus", "_"], ["A-S-;", "A-:"],
    ["C-S-1", "C-!"], [" ", "space"], ["\r\n", "ret"], ["F12", "f12"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
    expect(normalizeKey(expected)).toBe(expected);
  });

  it("rejects ambiguous, missing, unknown and duplicate keys", () => {
    for (const key of ["", "C-", "A--", "C-C-s", "g g", "unknown", "__proto__", "constructor-x"]) {
      expect(() => normalizeKey(key), key).toThrow();
    }
  });

  it("normalizes browser modifiers without capturing IME or AltGraph", () => {
    expect(keyFromEvent({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })).toBe("C-S-k");
    expect(keyFromEvent({ key: "Escape" })).toBe("esc");
    expect(keyFromEvent({ key: "s", metaKey: true })).toBe("Cmd-s");
    expect(keyFromEvent({ key: "˚", code: "KeyK", altKey: true })).toBe("A-k");
    expect(keyFromEvent({ key: "Dead", code: "KeyE", altKey: true })).toBe("A-e");
    expect(keyFromEvent({ key: "_", code: "Minus", altKey: true, shiftKey: true })).toBe("A-_");
    expect(keyFromEvent({ key: "a", isComposing: true })).toBeNull();
    expect(keyFromEvent({ key: "@", ctrlKey: true, altKey: true, getModifierState: name => name === "AltGraph" })).toBeNull();
    expect(keyFromEvent({ key: "Shift", shiftKey: true })).toBeNull();
  });

  it("round trips Unicode, literal angle brackets and named macro keys", () => {
    const keys = ["m", "i", "w", "A-x", "esc", "<", ">", "👩‍💻", "한", "é", "space", "Cmd-s"];
    const encoded = encodeKeys(keys);
    expect(encoded).toBe("miw<A-x><esc><lt>>👩‍💻한é<space><Cmd-s>");
    expect(decodeKeys(encoded)).toEqual(keys);
    expect(() => decodeKeys("foo<C-s")).toThrow(/Unclosed/);
    expect(() => decodeKeys("foo<unknown>")).toThrow(/Unknown/);
  });
});

describe("mode keymaps", () => {
  const commands = ["left", "right", "up", "down", "insert_mode", "normal_mode"];
  const defaults: Keymaps = {
    normal: { h: "left", l: "right", g: { g: "up", e: "down" } },
    select: { h: "left" },
    insert: { esc: "normal_mode" },
  };

  it("resolves nested, mode-specific bindings and exposes prefix help", () => {
    const engine = new KeymapEngine(defaults, { commands });
    expect(engine.lookup("normal", ["g"])).toEqual({ kind: "pending", next: ["g", "e"] });
    expect(engine.lookup("normal", ["g", "e"])).toEqual({ kind: "commands", commands: ["down"] });
    expect(engine.lookup("insert", ["h"])).toEqual({ kind: "unbound", explicit: false });
    expect(engine.lookup("insert", ["Escape"])).toEqual({ kind: "commands", commands: ["normal_mode"] });
    expect(engine.list("normal", ["g"])).toEqual([
      { keys: ["g", "g"], binding: { kind: "commands", commands: ["up"] } },
      { keys: ["g", "e"], binding: { kind: "commands", commands: ["down"] } },
    ]);
  });

  it("merges nested overrides and replaces leaf or prefix bindings explicitly", () => {
    const engine = new KeymapEngine(defaults, { commands });
    expect(engine.replace({ normal: { g: { g: "down", x: "right" } } }).ok).toBe(true);
    expect(engine.lookup("normal", ["g", "g"])).toEqual({ kind: "commands", commands: ["down"] });
    expect(engine.lookup("normal", ["g", "e"])).toEqual({ kind: "commands", commands: ["down"] });
    expect(engine.replace({ normal: { g: "left", h: { l: "right" } } }).ok).toBe(true);
    expect(engine.lookup("normal", ["g"])).toEqual({ kind: "commands", commands: ["left"] });
    expect(engine.lookup("normal", ["g", "g"])).toEqual({ kind: "unbound", explicit: false });
    expect(engine.lookup("normal", ["h", "l"])).toEqual({ kind: "commands", commands: ["right"] });
    expect(engine.replace({}).ok).toBe(true);
    expect(engine.lookup("normal", ["h"])).toEqual({ kind: "commands", commands: ["left"] });
  });

  it("keeps deletion, no_op and pass-through distinct", () => {
    const engine = new KeymapEngine(defaults, { commands });
    engine.replace({ normal: { h: null, l: "no_op", "C-ret": "pass_through" } });
    expect(engine.lookup("normal", ["h"])).toEqual({ kind: "unbound", explicit: true });
    expect(engine.lookup("normal", ["l"])).toEqual({ kind: "commands", commands: ["no_op"] });
    expect(engine.lookup("normal", ["C-ret"])).toEqual({ kind: "pass" });
  });

  it("resolves command arrays, colon commands and standalone key macros", () => {
    const engine = new KeymapEngine({}, { commands });
    expect(engine.replace({
      normal: { a: ["insert_mode", "normal_mode"], "C-s": ":write", "A-x": "@miw<A-x>" },
    }).ok).toBe(true);
    expect(engine.lookup("normal", ["a"])).toEqual({ kind: "commands", commands: ["insert_mode", "normal_mode"] });
    expect(engine.lookup("normal", ["C-s"])).toEqual({ kind: "commands", commands: [":write"] });
    expect(engine.lookup("normal", ["A-x"])).toEqual({ kind: "macro", keys: ["m", "i", "w", "A-x"] });
  });

  it("rejects invalid replacements atomically and reports precise paths", () => {
    const engine = new KeymapEngine(defaults, { commands });
    const before = engine.list("normal");
    const revision = engine.revision;
    const result = engine.replace({ normal: { h: "up", g: { x: "unsupported" }, a: ["@miw"], b: "@<oops>" } });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(item => [item.path, item.code])).toEqual([
      ["keys.normal.g.x", "unknown_command"], ["keys.normal.a[0]", "invalid_sequence"], ["keys.normal.b", "invalid_macro"],
    ]);
    expect(engine.list("normal")).toEqual(before);
    expect(engine.revision).toBe(revision);
    expect(engine.replace({ normal: { h: "up" } }).ok).toBe(true);
    expect(engine.revision).toBe(revision + 1);
  });

  it("rejects aliases colliding inside one table, malformed values and invalid modes", () => {
    const engine = new KeymapEngine({}, { commands });
    const invalid = {
      normal: { "Ctrl-s": "left", "C-s": "right", a: 42, b: [], c: "", d: ":" },
      terminal: { a: "left" },
    } as unknown as Keymaps;
    const result = engine.replace(invalid);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(item => item.code)).toEqual([
      "duplicate_key", "invalid_binding", "empty_sequence", "empty_command", "empty_command", "invalid_mode",
    ]);
    expect(() => new KeymapEngine({ normal: { a: "unknown" } }, { commands })).toThrow(KeymapError);
  });

  it("detects cyclic and excessively deep maps without changing live bindings", () => {
    const engine = new KeymapEngine(defaults, { commands, maxDepth: 3 });
    const cycle: Record<string, unknown> = {};
    cycle.g = cycle;
    expect(engine.replace({ normal: cycle } as Keymaps).diagnostics.some(item => item.code === "cyclic_keymap")).toBe(true);
    expect(engine.replace({ normal: { a: { b: { c: { d: "left" } } } } }).diagnostics.some(item => item.code === "depth_limit")).toBe(true);
    expect(engine.lookup("normal", ["h"])).toEqual({ kind: "commands", commands: ["left"] });
    expect(new KeymapEngine({}, { maxBindings: 1 }).replace({ normal: { a: "left", b: "right" } }).ok).toBe(false);
  });

  it("does not expose mutable internal keymap arrays", () => {
    const engine = new KeymapEngine(defaults, { commands });
    const result = engine.lookup("normal", ["h"]);
    if (result.kind === "commands") result.commands[0] = "right";
    const listed = engine.list("normal");
    listed[0]!.keys[0] = "x";
    if (listed[0]!.binding.kind === "commands") listed[0]!.binding.commands[0] = "right";
    expect(engine.lookup("normal", ["h"])).toEqual({ kind: "commands", commands: ["left"] });
  });
});

describe("TOML keymap import", () => {
  it("imports mode tables, modifier aliases, command arrays and inline prefixes", () => {
    const result = importKeymapToml(`
theme = "base16_default"
[editor]
line-number = "relative"
[keys.normal]
C-s = ":write"
g = { a = "left" }
ret = ["insert_mode", "normal_mode"]
A-x = "@miw<A-x>"
[keys.insert.j]
k = "normal_mode"
[keys.select]
h = "left"
`, { commands: ["left", "insert_mode", "normal_mode"] });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter(item => item.code === "ignored_section").map(item => item.path)).toEqual(["theme", "editor"]);
    const engine = new KeymapEngine(result.keymap);
    expect(engine.lookup("insert", ["j", "k"])).toEqual({ kind: "commands", commands: ["normal_mode"] });
    expect(engine.lookup("normal", ["g", "a"])).toEqual({ kind: "commands", commands: ["left"] });
    expect(engine.lookup("normal", ["ret"])).toEqual({ kind: "commands", commands: ["insert_mode", "normal_mode"] });
  });

  it("rejects malformed TOML and unsupported commands before applying anything", () => {
    expect(importKeymapToml("[keys.normal\nx = 3").diagnostics[0]!.code).toBe("invalid_toml");
    const engine = new KeymapEngine({ normal: { h: "left" } }, { commands: ["left"] });
    const result = applyKeymapToml(engine, '[keys.normal]\nh = "right"');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(item => item.code === "unknown_command")).toBe(true);
    expect(engine.lookup("normal", ["h"])).toEqual({ kind: "commands", commands: ["left"] });
  });

  it("rejects non-table mode settings and prototype keys", () => {
    expect(importKeymapToml('[keys]\nnormal = "left"').ok).toBe(false);
    expect(importKeymapToml('[keys.normal]\na = 2026-10-18').ok).toBe(false);
    expect(importKeymapToml('[keys.normal.__proto__]\nx = "left"').ok).toBe(false);
  });
});
