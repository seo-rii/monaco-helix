import type { HelixSelection } from "./selection.js";

export interface SearchOptions {
  maxMatches?: number;
  maxDocumentLength?: number;
  maxPatternLength?: number;
  caseSensitive?: boolean;
  multiline?: boolean;
  /** Apply the regex independently to these selection scopes, in their original order. */
  ranges?: readonly HelixSelection[];
}

export interface SearchConfiguration extends SearchOptions { timeoutMs?: number; workerFactory?: () => Worker }

export interface SearchResult {
  matches: HelixSelection[];
  truncated: boolean;
  /** Present for scoped searches; distinguishes empty matches at adjacent scope boundaries. */
  groups?: HelixSelection[][];
}

/** Pure worker engine. Run untrusted regexes in a Worker, never on the UI thread. */
export function findSearchMatches(text: string, pattern: string, options: SearchOptions = {}): SearchResult {
  // Keep this function self-contained: its source also forms the default Blob worker.
  const limit = Math.max(1, Math.min(10_000, Math.trunc(options.maxMatches ?? 1000) || 1000));
  const maxDocument = Math.max(0, Math.min(10_000_000, Math.trunc(options.maxDocumentLength ?? 2_000_000) || 0));
  const maxPattern = Math.max(0, Math.min(10_000, Math.trunc(options.maxPatternLength ?? 2000) || 0));
  if (text.length > maxDocument) throw new RangeError(`Search document exceeds ${maxDocument} UTF-16 units`);
  if (pattern.length > maxPattern) throw new RangeError(`Search pattern exceeds ${maxPattern} UTF-16 units`);
  if (!pattern) return { matches: [], truncated: false };
  const regex = new RegExp(pattern, `gu${options.multiline === false ? "" : "m"}${options.caseSensitive === false ? "i" : ""}`);
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  const matches: HelixSelection[] = [];
  const groups: HelixSelection[][] | undefined = options.ranges ? [] : undefined;
  const result = (truncated: boolean): SearchResult => ({ matches, truncated, ...(groups ? { groups } : {}) });
  const startOf = (offset: number) => offset >= text.length ? text.length : segments.containing(offset)?.index ?? offset;
  const regions = options.ranges ?? [{ anchor: 0, head: text.length }];
  if (regions.length > 10_000) throw new RangeError("Search exceeds 10000 selection scopes");
  for (const range of regions) {
    const rawStart = Math.min(range.anchor, range.head);
    const rawStop = Math.max(range.anchor, range.head);
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawStop) || rawStart < 0 || rawStop > text.length) {
      throw new RangeError("Search scopes require valid document offsets");
    }
    const start = startOf(rawStart);
    const stopPart = rawStop < text.length ? segments.containing(rawStop) : undefined;
    const stop = rawStart === rawStop ? start
      : stopPart && stopPart.index !== rawStop ? stopPart.index + stopPart.segment.length : rawStop;
    const source = text.slice(start, stop);
    const firstResult = matches.length;
    const group: HelixSelection[] = [];
    groups?.push(group);
    regex.lastIndex = 0;
    for (let match: RegExpExecArray | null; (match = regex.exec(source));) {
      const anchor = startOf(start + match.index);
      const rawEnd = start + match.index + match[0].length;
      const endPart = rawEnd < text.length ? segments.containing(rawEnd) : undefined;
      const head = match[0].length === 0 ? anchor
        : endPart && endPart.index !== rawEnd ? endPart.index + endPart.segment.length : rawEnd;
      const last = matches.length > firstResult ? matches.at(-1) : undefined;
      if (last && (anchor < last.head || (anchor === last.anchor && head === last.head))) {
        last.head = Math.max(last.head, head);
      } else {
        if (matches.length === limit) return result(true);
        const selection = { anchor, head };
        matches.push(selection);
        group.push(selection);
      }
      if (match[0].length === 0) {
        // Unicode AdvanceStringIndex, including zero-width EOF matches.
        if (regex.lastIndex >= source.length) break;
        regex.lastIndex += (source.codePointAt(regex.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      }
    }
  }
  return result(false);
}

export class SearchHistory {
  private patterns: string[] = [];
  private cursor = 0;
  private draft = "";
  private readonly limit: number;

  constructor(limit = 50) { this.limit = Math.max(1, Math.min(1000, Math.trunc(limit) || 50)); }
  values(): string[] { return [...this.patterns]; }
  record(pattern: string): void {
    if (pattern) {
      this.patterns = this.patterns.filter(value => value !== pattern);
      this.patterns.push(pattern);
      if (this.patterns.length > this.limit) this.patterns.shift();
    }
    this.reset();
  }
  previous(draft = ""): string {
    if (this.cursor === this.patterns.length) this.draft = draft;
    this.cursor = Math.max(0, this.cursor - 1);
    return this.patterns[this.cursor] ?? draft;
  }
  next(): string {
    this.cursor = Math.min(this.patterns.length, this.cursor + 1);
    return this.patterns[this.cursor] ?? this.draft;
  }
  reset(): void { this.cursor = this.patterns.length; this.draft = ""; }
}

export interface SearchEngine {
  search(text: string, pattern: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResult>;
  cancel(): void;
  dispose(): void;
}

/** A new, terminable Worker per search enforces a real wall-clock regex budget. */
export function createWorkerSearchEngine(options: { timeoutMs?: number; workerFactory?: () => Worker } = {}): SearchEngine {
  let active: { cancel: () => void } | undefined;
  let disposed = false;
  const timeoutMs = Math.max(10, Math.min(30_000, options.timeoutMs ?? 500));
  const abortError = () => new DOMException("Search cancelled", "AbortError");
  const cancel = () => { active?.cancel(); active = undefined; };
  return {
    cancel,
    dispose() { disposed = true; cancel(); },
    search(text, pattern, searchOptions = {}, signal) {
      cancel();
      if (disposed || signal?.aborted) return Promise.reject(abortError());
      return new Promise<SearchResult>((resolve, reject) => {
        let worker: Worker;
        let url: string | undefined;
        try {
          if (options.workerFactory) worker = options.workerFactory();
          else {
            if (typeof Worker === "undefined") throw new Error("Search requires a Worker or a host workerFactory");
            const source = `const search = (${findSearchMatches.toString()});self.onmessage = event => {try {self.postMessage({result:search(...event.data)})}catch(error){self.postMessage({error:{name:error.name,message:error.message}})}};`;
            url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            worker = new Worker(url);
          }
        } catch (error) {
          if (url) URL.revokeObjectURL(url);
          reject(error);
          return;
        }
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => finish(undefined, abortError());
        const request = { cancel: abort };
        const finish = (result?: SearchResult, error?: unknown) => {
          if (finished) return;
          finished = true;
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
          if (url) URL.revokeObjectURL(url);
          if (active === request) active = undefined;
          if (error !== undefined) reject(error);
          else resolve(result!);
        };
        active = request;
        worker.onmessage = (event: MessageEvent<{ result?: SearchResult; error?: { name: string; message: string } }>) => {
          if (event.data.error) {
            const error = new Error(event.data.error.message);
            error.name = event.data.error.name;
            finish(undefined, error);
          } else if (event.data.result) finish(event.data.result);
          else finish(undefined, new Error("Invalid search worker response"));
        };
        worker.onerror = event => { event.preventDefault(); finish(undefined, new Error(event.message || "Search worker failed")); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => finish(undefined, new Error(`Search exceeded ${timeoutMs}ms budget`)), timeoutMs);
        try { worker.postMessage([text, pattern, searchOptions]); }
        catch (error) { finish(undefined, error); }
      });
    },
  };
}

/** Prompt preview transaction; captures selection/viewport in a host-defined snapshot. */
export class SearchPreviewSession<T> {
  private closed = false;
  private sequence = 0;
  private controller?: AbortController;
  constructor(private readonly options: { snapshot: T; restore: (snapshot: T) => void; isCurrent?: () => boolean }) {}

  async update<R>(operation: (signal: AbortSignal) => R | Promise<R>, apply: (result: R) => void): Promise<boolean> {
    this.stop();
    if (this.closed || this.options.isCurrent?.() === false) return false;
    const current = this.sequence;
    const controller = new AbortController();
    this.controller = controller;
    let finishAbort!: () => void;
    const aborted = new Promise<undefined>(resolve => { finishAbort = () => resolve(undefined); });
    controller.signal.addEventListener("abort", finishAbort, { once: true });
    try {
      const result = await Promise.race([
        Promise.resolve(operation(controller.signal)).then(value => ({ value })), aborted,
      ]);
      if (this.closed || controller.signal.aborted || current !== this.sequence || this.options.isCurrent?.() === false) return false;
      if (!result) return false;
      apply(result.value);
      return true;
    } catch (error) {
      if (this.closed || controller.signal.aborted || current !== this.sequence || this.options.isCurrent?.() === false) return false;
      throw error;
    } finally {
      controller.signal.removeEventListener("abort", finishAbort);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private stop(): void { this.sequence++; this.controller?.abort(); this.controller = undefined; }
  accept(): void { this.closed = true; this.stop(); }
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    if (this.options.isCurrent?.() !== false) this.options.restore(this.options.snapshot);
  }
  dispose(): void { this.closed = true; this.stop(); }
}
