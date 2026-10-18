import { decodeKeys, encodeKeys, normalizeKey } from "./keymap.js";

/** Key streams retain remapping semantics; text events contain committed input only. */
export type MacroEvent =
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "prompt"; value: string; prefix?: string; cancel?: boolean }
  | { type: "replay"; register: string; count?: number };

export type ExecutableMacroEvent = Exclude<MacroEvent, { type: "replay" }>;

export interface MacroExecutionContext {
  signal: AbortSignal;
  /** Nested replay shares cancellation, recursion detection and the total step budget. */
  play: (register?: string, count?: number) => Promise<void>;
  /** Inline key macros participate in the same recursion and step limits. */
  playKeys: (keys: readonly string[] | string, count?: number) => Promise<void>;
}

export interface MacroState {
  recording: string | null;
  playing: boolean;
}

export interface MacroOptions {
  execute: (event: ExecutableMacroEvent, signal: AbortSignal, context: MacroExecutionContext) => void | Promise<void>;
  maxSteps?: number;
  maxDepth?: number;
  maxRecordedEvents?: number;
  yieldEvery?: number;
  /** An injectable yield point for hosts and deterministic tests. */
  yield?: (signal: AbortSignal) => void | Promise<void>;
  onChange?: (state: MacroState) => void;
  /** Exceptions raised by onChange are routed here and cannot corrupt playback. */
  onError?: (error: unknown) => void;
}

export interface MacroPlayOptions {
  signal?: AbortSignal;
}

export type MacroErrorCode = "disposed" | "busy" | "not_recording" | "already_recording"
  | "invalid_event" | "invalid_register" | "invalid_count" | "missing_register"
  | "recursive_macro" | "depth_limit" | "step_limit" | "recording_limit"
  | "cancelled" | "inactive_context" | "not_key_macro";

export class MacroError extends Error {
  constructor(readonly code: MacroErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = code === "cancelled" ? "AbortError" : "MacroError";
  }
}

interface Playback {
  controller: AbortController;
  steps: number;
}

function cancelled(signal: AbortSignal): MacroError {
  return new MacroError("cancelled", "Macro playback cancelled", { cause: signal.reason });
}

/** Abort promptly even when an injected host operation never settles. */
function waitFor<T>(operation: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled(signal)); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

const registerCharacters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function registerName(register: string): string {
  if (typeof register !== "string" || !register || /[\u0000-\u001f\u007f]/u.test(register)
    || registerCharacters.segment(register).containing(0)?.segment.length !== register.length) {
    throw new MacroError("invalid_register", "A macro register must be a single printable grapheme");
  }
  return register;
}

function repeatCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
    throw new MacroError("invalid_count", "Macro counts must be integers from 0 to 10000");
  }
  return count;
}

function copyEvent(event: MacroEvent): MacroEvent {
  if (!event || typeof event !== "object") throw new MacroError("invalid_event", "A macro event must be an object");
  switch (event.type) {
    case "key":
      try { return { type: "key", key: normalizeKey(event.key) }; }
      catch (error) { throw new MacroError("invalid_event", "A macro key must use supported key notation", { cause: error }); }
    case "text":
      if (typeof event.text !== "string") break;
      return { type: "text", text: event.text };
    case "prompt":
      if (typeof event.value !== "string" || (event.prefix !== undefined && typeof event.prefix !== "string")
        || (event.cancel !== undefined && typeof event.cancel !== "boolean")) break;
      return {
        type: "prompt", value: event.value,
        ...(event.prefix !== undefined ? { prefix: event.prefix } : {}),
        ...(event.cancel !== undefined ? { cancel: event.cancel } : {}),
      };
    case "replay":
      return { type: "replay", register: registerName(event.register), ...(event.count !== undefined ? { count: repeatCount(event.count) } : {}) };
  }
  throw new MacroError("invalid_event", "Unsupported or malformed macro event");
}

/**
 * Registers, recording and ordered playback without synthesizing DOM events.
 * The executor owns editor/model guards and must honor the supplied signal.
 */
export class MacroEngine {
  private registers = new Map<string, MacroEvent[]>();
  private recording: { register: string; events: MacroEvent[] } | undefined;
  private playback: Playback | undefined;
  private disposed = false;
  private maxSteps: number;
  private maxDepth: number;
  private maxRecordedEvents: number;
  private yieldEvery: number;

  constructor(private options: MacroOptions) {
    this.maxSteps = options.maxSteps ?? 100_000;
    this.maxDepth = options.maxDepth ?? 32;
    this.maxRecordedEvents = options.maxRecordedEvents ?? 100_000;
    this.yieldEvery = options.yieldEvery ?? 128;
    for (const [name, value] of Object.entries({ maxSteps: this.maxSteps, maxDepth: this.maxDepth, maxRecordedEvents: this.maxRecordedEvents, yieldEvery: this.yieldEvery })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
    }
    if (typeof options.execute !== "function") throw new Error("A macro executor is required");
  }

  get isRecording(): boolean { return !!this.recording; }
  get isPlaying(): boolean { return !!this.playback; }
  get recordingRegister(): string | null { return this.recording?.register ?? null; }

  start(register = "@"): void {
    this.assertUsable();
    if (this.playback) throw new MacroError("busy", "Cannot start recording during playback");
    if (this.recording) throw new MacroError("already_recording", "A macro is already recording");
    this.recording = { register: registerName(register), events: [] };
    this.changed();
  }

  /** Save a completed recording. Start/stop control keys should not be passed to record(). */
  stop(): MacroEvent[] {
    this.assertUsable();
    if (!this.recording) throw new MacroError("not_recording", "No macro is recording");
    const { register, events } = this.recording;
    this.recording = undefined;
    this.registers.set(register, events.map(copyEvent));
    this.changed();
    return events.map(copyEvent);
  }

  toggle(register = "@"): boolean {
    if (this.recording) this.stop(); else this.start(register);
    return this.isRecording;
  }

  /** Discard only the in-progress recording, preserving the previous register value. */
  discard(): boolean {
    const existed = !!this.recording;
    this.recording = undefined;
    if (existed) this.changed();
    return existed;
  }

  record(event: MacroEvent): boolean {
    this.assertUsable();
    if (!this.recording || this.playback) return false;
    if (this.recording.events.length >= this.maxRecordedEvents) {
      this.discard();
      throw new MacroError("recording_limit", `Recording exceeds ${this.maxRecordedEvents} events`);
    }
    this.recording.events.push(copyEvent(event));
    return true;
  }

  set(register: string, events: readonly MacroEvent[] | string): void {
    this.assertUsable();
    const name = registerName(register);
    const validated = typeof events === "string"
      ? decodeKeys(events).map(key => ({ type: "key" as const, key }))
      : events.map(copyEvent);
    if (validated.length > this.maxRecordedEvents) throw new MacroError("recording_limit", `A macro exceeds ${this.maxRecordedEvents} events`);
    this.registers.set(name, validated);
  }

  get(register = "@"): MacroEvent[] | undefined {
    return this.registers.get(registerName(register))?.map(copyEvent);
  }

  /** Helix-compatible text is available only for a pure key stream. */
  getKeys(register = "@"): string | undefined {
    const events = this.get(register);
    if (!events) return;
    if (events.some(event => event.type !== "key")) throw new MacroError("not_key_macro", "This macro contains committed text, prompt responses or nested replay events; export its event list instead");
    return encodeKeys(events.map(event => (event as { type: "key"; key: string }).key));
  }

  list(): string[] { return [...this.registers.keys()]; }
  delete(register: string): boolean { return this.registers.delete(registerName(register)); }

  async play(register = "@", count = 1, options: MacroPlayOptions = {}): Promise<void> {
    this.assertUsable();
    const name = registerName(register);
    repeatCount(count);
    return this.startPlayback(run => this.replay(run, name, count), options);
  }

  async playKeys(keys: readonly string[] | string, count = 1, options: MacroPlayOptions = {}): Promise<void> {
    this.assertUsable();
    const normalized = typeof keys === "string" ? decodeKeys(keys) : keys.map(normalizeKey);
    repeatCount(count);
    return this.startPlayback(run => this.stream(run, normalized.map(key => ({ type: "key", key })), count, `keys:${encodeKeys(normalized)}`), options);
  }

  private async startPlayback(start: (run: Playback) => Promise<void>, options: MacroPlayOptions): Promise<void> {
    if (this.playback) throw new MacroError("busy", "A macro is already playing; use its execution context for nested playback");
    const run: Playback = { controller: new AbortController(), steps: 0 };
    const abort = () => run.controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    this.playback = run;
    this.changed();
    try { await start(run); }
    catch (error) {
      // Invalidate child requests started by a failing asynchronous executor.
      run.controller.abort(error);
      throw error;
    }
    finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.playback === run) {
        this.playback = undefined;
        this.changed();
      }
    }
  }

  cancel(reason?: unknown): boolean {
    if (!this.playback) return false;
    this.playback.controller.abort(reason);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.recording = undefined;
    this.registers.clear();
    this.cancel("disposed");
  }

  private assertUsable(): void {
    if (this.disposed) throw new MacroError("disposed", "The macro engine has been disposed");
  }

  private check(run: Playback): void {
    if (run.controller.signal.aborted) throw cancelled(run.controller.signal);
    this.assertUsable();
  }

  private changed(): void {
    if (this.disposed) return;
    try { this.options.onChange?.({ recording: this.recordingRegister, playing: this.isPlaying }); }
    catch (error) { try { this.options.onError?.(error); } catch { /* Host callbacks cannot corrupt engine state. */ } }
  }

  private async replay(run: Playback, register: string, count: number, ancestors: readonly string[] = []): Promise<void> {
    this.check(run);
    registerName(register);
    repeatCount(count);
    const events = this.registers.get(register)?.map(copyEvent);
    if (!events) throw new MacroError("missing_register", `Macro register ${JSON.stringify(register)} is empty`);
    return this.stream(run, events, count, `register:${register}`, ancestors);
  }

  private async stream(run: Playback, events: readonly MacroEvent[], count: number, identity: string, ancestors: readonly string[] = []): Promise<void> {
    this.check(run);
    repeatCount(count);
    if (ancestors.includes(identity)) throw new MacroError("recursive_macro", `Recursive macro ${JSON.stringify(identity)}`);
    if (ancestors.length >= this.maxDepth) throw new MacroError("depth_limit", `Macro nesting exceeds ${this.maxDepth}`);
    const stack = [...ancestors, identity];
      for (let iteration = 0; iteration < count; iteration++) {
        for (const event of events) {
          this.check(run);
          if (++run.steps > this.maxSteps) throw new MacroError("step_limit", `Macro playback exceeds ${this.maxSteps} events`);
          if (run.steps % this.yieldEvery === 0) {
            await waitFor(this.options.yield
              ? this.options.yield(run.controller.signal)
              : new Promise<void>(resolve => setTimeout(resolve, 0)), run.controller.signal);
            this.check(run);
          }
          if (event.type === "replay") await this.replay(run, event.register, event.count ?? 1, stack);
          else {
            let active = true;
            let children = Promise.resolve();
            const enqueue = (start: () => Promise<void>) => {
              if (!active || this.playback !== run) return Promise.reject(new MacroError("inactive_context", "This macro command has already completed"));
              const task = children.then(() => {
                if (!active) throw new MacroError("inactive_context", "This macro command has already completed");
                return start();
              });
              children = task;
              void task.catch(() => {});
              return task;
            };
            const context: MacroExecutionContext = {
              signal: run.controller.signal,
              // Await even unreturned child requests and serialize siblings.
              play: (child = "@", repeats = 1) => enqueue(() => this.replay(run, child, repeats, stack)),
              playKeys: (keys, repeats = 1) => enqueue(() => {
                const normalized = typeof keys === "string" ? decodeKeys(keys) : keys.map(normalizeKey);
                return this.stream(run, normalized.map(key => ({ type: "key", key })), repeats, `keys:${encodeKeys(normalized)}`, stack);
              }),
            };
            try {
              await waitFor(this.options.execute(copyEvent(event) as ExecutableMacroEvent, run.controller.signal, context), run.controller.signal);
              await waitFor(children, run.controller.signal);
            } finally { active = false; }
            this.check(run);
          }
        }
      }
  }
}
