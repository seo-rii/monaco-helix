import { describe, expect, it, vi } from "vitest";
import { MacroEngine, MacroError, type MacroEvent, type MacroExecutionContext } from "../src/macros.js";

const key = (value: string): MacroEvent => ({ type: "key", key: value });

describe("macro recording and registers", () => {
  it("records normalized keys, committed Unicode text and prompt responses", () => {
    const engine = new MacroEngine({ execute() {} });
    expect(engine.toggle()).toBe(true);
    engine.record(key("Escape"));
    engine.record({ type: "text", text: "한글👩‍💻" });
    engine.record({ type: "prompt", prefix: "/", value: "alpha.*" });
    expect(engine.toggle()).toBe(false);
    expect(engine.get()).toEqual([
      key("esc"), { type: "text", text: "한글👩‍💻" }, { type: "prompt", prefix: "/", value: "alpha.*" },
    ]);
    expect(() => engine.getKeys()).toThrow(expect.objectContaining({ code: "not_key_macro" }));
  });

  it("writes only completed recordings, and discard preserves an old register", () => {
    const engine = new MacroEngine({ execute() {} });
    engine.set("a", "hj");
    engine.start("a"); engine.record(key("x"));
    expect(engine.getKeys("a")).toBe("hj");
    expect(engine.discard()).toBe(true);
    expect(engine.getKeys("a")).toBe("hj");
    engine.start("b"); engine.record(key("l"));
    expect(engine.stop()).toEqual([key("l")]);
    expect(engine.list()).toEqual(["a", "b"]);
    expect(engine.delete("a")).toBe(true);
    expect(engine.get("a")).toBeUndefined();
  });

  it("copies event lists and exports pure key macros in Helix notation", () => {
    const engine = new MacroEngine({ execute() {} });
    const events = [key("m"), key("i"), key("w"), key("Ctrl-s")];
    engine.set("@", events);
    (events[0] as { key: string }).key = "x";
    const retrieved = engine.get()!;
    (retrieved[0] as { key: string }).key = "y";
    expect(engine.getKeys()).toBe("miw<C-s>");
    engine.set("b", "i한글<esc>");
    expect(engine.getKeys("b")).toBe("i한글<esc>");
  });

  it("validates registers, events and counts without replacing an existing macro", () => {
    const engine = new MacroEngine({ execute() {} });
    engine.set("a", "h");
    expect(() => engine.set("a", [{ type: "text", text: 12 }] as unknown as MacroEvent[])).toThrow(MacroError);
    expect(() => engine.set("long", "h")).toThrow(expect.objectContaining({ code: "invalid_register" }));
    expect(() => engine.set("b", [{ type: "replay", register: "a", count: Infinity }])).toThrow(expect.objectContaining({ code: "invalid_count" }));
    expect(engine.getKeys("a")).toBe("h");
    expect(() => engine.stop()).toThrow(expect.objectContaining({ code: "not_recording" }));
    engine.start();
    expect(() => engine.start()).toThrow(expect.objectContaining({ code: "already_recording" }));
  });

  it("bounds recording and keeps the previous completed register on overflow", () => {
    const engine = new MacroEngine({ execute() {}, maxRecordedEvents: 2 });
    engine.set("@", "h"); engine.start();
    engine.record(key("x")); engine.record(key("y"));
    expect(() => engine.record(key("z"))).toThrow(expect.objectContaining({ code: "recording_limit" }));
    expect(engine.isRecording).toBe(false);
    expect(engine.getKeys()).toBe("h");
  });
});

describe("ordered macro playback", () => {
  it("awaits asynchronous commands before continuing and repeats the whole macro", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const engine = new MacroEngine({ async execute(event) {
      if (event.type === "key") {
        seen.push(`${event.key}:start`);
        if (event.key === "h") await gate;
        seen.push(`${event.key}:end`);
      }
    } });
    engine.set("@", "hl");
    const played = engine.play("@", 2);
    expect(seen).toEqual(["h:start"]);
    release(); await played;
    expect(seen).toEqual(["h:start", "h:end", "l:start", "l:end", "h:start", "h:end", "l:start", "l:end"]);
    expect(engine.isPlaying).toBe(false);
  });

  it("plays committed text and prompt responses without synthesizing keyboard events", async () => {
    const seen: MacroEvent[] = [];
    const engine = new MacroEngine({ execute(event) { seen.push(event); } });
    engine.set("a", [key("i"), { type: "text", text: "한글" }, key("esc"), key("/"), { type: "prompt", prefix: "/", value: "한글" }]);
    await engine.play("a");
    expect(seen).toEqual(engine.get("a"));
  });

  it("supports nested register events and rejects direct and indirect recursion", async () => {
    const seen: string[] = [];
    const engine = new MacroEngine({ execute(event) { if (event.type === "key") seen.push(event.key); } });
    engine.set("a", [key("h"), { type: "replay", register: "b", count: 2 }, key("l")]);
    engine.set("b", "j");
    await engine.play("a");
    expect(seen).toEqual(["h", "j", "j", "l"]);
    engine.set("b", [{ type: "replay", register: "a" }]);
    await expect(engine.play("a")).rejects.toMatchObject({ code: "recursive_macro" });
    expect(engine.isPlaying).toBe(false);
    engine.set("b", [{ type: "replay", register: "b" }]);
    await expect(engine.play("b")).rejects.toMatchObject({ code: "recursive_macro" });
  });

  it("serializes nested context requests, including requests the executor did not return", async () => {
    const seen: string[] = [];
    const engine = new MacroEngine({ execute(event, _signal, context) {
      if (event.type !== "key") return;
      seen.push(event.key);
      if (event.key === "q") { void context.play("b"); void context.play("c"); }
    } });
    engine.set("a", "ql"); engine.set("b", "h"); engine.set("c", "j");
    await engine.play("a");
    expect(seen).toEqual(["q", "h", "j", "l"]);
  });

  it("shares step and depth bounds across nested replays", async () => {
    const engine = new MacroEngine({ execute() {}, maxSteps: 3, yieldEvery: 100 });
    engine.set("a", [{ type: "replay", register: "b", count: 2 }]); engine.set("b", "hl");
    await expect(engine.play("a")).rejects.toMatchObject({ code: "step_limit" });
    const shallow = new MacroEngine({ execute() {}, maxDepth: 1 });
    shallow.set("a", [{ type: "replay", register: "b" }]); shallow.set("b", "h");
    await expect(shallow.play("a")).rejects.toMatchObject({ code: "depth_limit" });
  });

  it("shares recursion and step bounds between inline keys and named registers", async () => {
    const recursive = new MacroEngine({ execute(event, _signal, context) {
      if (event.type === "key" && event.key === "z") return context.playKeys("z");
    } });
    recursive.set("a", "z");
    await expect(recursive.play("a")).rejects.toMatchObject({ code: "recursive_macro" });
    const seen: string[] = [];
    const bounded = new MacroEngine({ maxSteps: 3, execute(event, _signal, context) {
      if (event.type !== "key") return;
      seen.push(event.key);
      if (event.key === "q") return context.play("a");
    } });
    bounded.set("a", "hj");
    await expect(bounded.playKeys("qq")).rejects.toMatchObject({ code: "step_limit" });
    expect(seen).toEqual(["q", "h", "j"]);
  });

  it("yields during long replays and observes cancellation before the next step", async () => {
    const seen: string[] = [];
    const engine = new MacroEngine({
      execute(event) { if (event.type === "key") seen.push(event.key); },
      yieldEvery: 2,
      yield() { engine.cancel("user interrupted"); },
    });
    engine.set("@", "hjl");
    await expect(engine.play()).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    expect(seen).toEqual(["h"]);
    expect(engine.isPlaying).toBe(false);
  });

  it("cancels even if the current injected command never resolves", async () => {
    let signal!: AbortSignal;
    const engine = new MacroEngine({ execute(_event, current) { signal = current; return new Promise<void>(() => {}); } });
    engine.set("@", "h");
    const played = engine.play();
    const rejection = expect(played).rejects.toMatchObject({ name: "AbortError" });
    engine.cancel();
    await rejection;
    expect(signal.aborted).toBe(true);
    expect(engine.isPlaying).toBe(false);
  });

  it("links external cancellation and does not run pre-aborted playback", async () => {
    const execute = vi.fn();
    const engine = new MacroEngine({ execute }); engine.set("@", "h");
    const abort = new AbortController(); abort.abort("model changed");
    await expect(engine.play("@", 1, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels an active host operation through an external signal", async () => {
    let received!: AbortSignal;
    const engine = new MacroEngine({ execute(_event, signal) { received = signal; return new Promise<void>(() => {}); } });
    engine.set("@", "h");
    const external = new AbortController();
    const played = engine.play("@", 1, { signal: external.signal });
    const rejection = expect(played).rejects.toMatchObject({ name: "AbortError" });
    external.abort();
    await rejection;
    expect(received.aborted).toBe(true);
  });

  it("rejects concurrent playback and recording while playing", async () => {
    let release!: () => void;
    const engine = new MacroEngine({ execute() { return new Promise<void>(resolve => release = resolve); } });
    engine.set("@", "h"); const first = engine.play();
    await expect(engine.play()).rejects.toMatchObject({ code: "busy" });
    expect(() => engine.start()).toThrow(expect.objectContaining({ code: "busy" }));
    release(); await first;
  });

  it("does not re-record generated playback events", async () => {
    const engine = new MacroEngine({ execute(event) { expect(engine.record(event)).toBe(false); } });
    engine.set("b", "hl"); engine.start("a"); engine.record({ type: "replay", register: "b" });
    await engine.play("b"); engine.stop();
    expect(engine.get("a")).toEqual([{ type: "replay", register: "b" }]);
  });

  it("uses a snapshot while a host replaces the active register", async () => {
    const seen: string[] = [];
    const engine = new MacroEngine({ execute(event) {
      if (event.type === "key") { seen.push(event.key); engine.set("@", "x"); }
    } });
    engine.set("@", "hl"); await engine.play();
    expect(seen).toEqual(["h", "l"]);
    expect(engine.getKeys()).toBe("x");
  });

  it("cleans up after executor failure and invalidates captured execution contexts", async () => {
    let captured!: MacroExecutionContext;
    const engine = new MacroEngine({ execute(_event, _signal, context) { captured = context; throw new Error("host failed"); } });
    engine.set("@", "h");
    await expect(engine.play()).rejects.toThrow("host failed");
    expect(engine.isPlaying).toBe(false);
    await expect(captured.play()).rejects.toMatchObject({ code: "inactive_context" });
  });

  it("does not leave child playback running after its requesting executor fails", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const engine = new MacroEngine({ execute(event, _signal, context) {
      if (event.type !== "key") return;
      if (event.key === "q") { void context.play("b"); return Promise.reject(new Error("parent failed")); }
      seen.push(event.key);
      if (event.key === "h") return gate;
    } });
    engine.set("a", "q"); engine.set("b", "hl");
    await expect(engine.play("a")).rejects.toThrow("parent failed");
    release();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(seen).not.toContain("l");
    expect(engine.isPlaying).toBe(false);
  });

  it("cancels and releases registers on disposal", async () => {
    const engine = new MacroEngine({ execute() { return new Promise<void>(() => {}); } });
    engine.set("@", "h"); const played = engine.play();
    const rejection = expect(played).rejects.toMatchObject({ name: "AbortError" });
    engine.dispose(); await rejection;
    expect(engine.list()).toEqual([]);
    await expect(engine.play()).rejects.toMatchObject({ code: "disposed" });
    expect(() => engine.start()).toThrow(expect.objectContaining({ code: "disposed" }));
  });

  it("protects state when host status callbacks throw or cancel synchronously", async () => {
    const errors: unknown[] = [];
    const execute = vi.fn();
    const engine = new MacroEngine({ execute, onChange(state) {
      if (state.playing) engine.cancel();
      throw new Error("status failed");
    }, onError(error) { errors.push(error); } });
    engine.set("@", "h");
    await expect(engine.play()).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
    expect(errors).toHaveLength(2);
  });
});
