import type { HelixSelection } from "./selection.js";

/** Serializable location. Models and files always remain owned by the host. */
export interface NavigationLocation {
  uri: string;
  selections: HelixSelection[];
  version?: number;
  viewport?: { scrollTop: number; scrollLeft: number };
}

export interface HostRequestContext {
  signal: AbortSignal;
  requestId: number;
  reason: string;
}

export interface HostItem {
  id: string;
  label: string;
  description?: string;
  location?: NavigationLocation;
  command?: string;
}

/** Return false for an unavailable destination, or its actual clamped location. */
export type OpenLocation = (
  location: NavigationLocation,
  context: HostRequestContext,
) => void | false | NavigationLocation | Promise<void | false | NavigationLocation>;

/** Optional workbench capabilities; no filesystem or language service is bundled. */
export interface HostAdapter {
  listBuffers?: (query: string, context: HostRequestContext) => readonly HostItem[] | Promise<readonly HostItem[]>;
  queryFiles?: (query: string, context: HostRequestContext) => readonly HostItem[] | Promise<readonly HostItem[]>;
  querySymbols?: (query: string, context: HostRequestContext) => readonly HostItem[] | Promise<readonly HostItem[]>;
  openLocation?: OpenLocation;
  executeCommand?: (command: string, context: HostRequestContext) => void | Promise<void>;
}

const copy = (location: NavigationLocation): NavigationLocation => ({
  uri: location.uri,
  selections: location.selections.map(selection => ({ ...selection })),
  ...(location.version === undefined ? {} : { version: location.version }),
  ...(location.viewport === undefined ? {} : { viewport: { ...location.viewport } }),
});

function sameLocation(left: NavigationLocation, right: NavigationLocation): boolean {
  return left.uri === right.uri && left.selections.length === right.selections.length
    && left.selections.every((selection, index) => selection.anchor === right.selections[index]?.anchor
      && selection.head === right.selections[index]?.head);
}

/** One superseding request at a time, with stale-result protection even for hosts ignoring abort. */
export class HostRequestController {
  private controller?: AbortController;
  private sequence = 0;
  private disposed = false;

  async run<T>(
    reason: string,
    operation: (context: HostRequestContext) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ value: T } | undefined> {
    this.cancel();
    if (this.disposed || signal?.aborted) return undefined;
    const controller = new AbortController();
    this.controller = controller;
    const requestId = this.sequence;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let finishAbort!: () => void;
    const aborted = new Promise<undefined>(resolve => { finishAbort = () => resolve(undefined); });
    controller.signal.addEventListener("abort", finishAbort, { once: true });
    try {
      if (signal?.aborted) controller.abort();
      if (controller.signal.aborted) return undefined;
      const result = await Promise.race([
        Promise.resolve(operation({ signal: controller.signal, requestId, reason })).then(value => ({ value })),
        aborted,
      ]);
      if (controller.signal.aborted || this.disposed || requestId !== this.sequence) return undefined;
      return result;
    } catch (error) {
      if (controller.signal.aborted || this.disposed || requestId !== this.sequence) return undefined;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", finishAbort);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  cancel(): void {
    this.sequence++;
    this.controller?.abort();
    this.controller = undefined;
  }

  dispose(): void { this.disposed = true; this.cancel(); }
}

/** Bounded, branching jumplist. Entries are immutable copies, never live Monaco models. */
export class NavigationHistory {
  private entries: NavigationLocation[] = [];
  private index = -1;
  private readonly requests = new HostRequestController();
  private disposed = false;
  private readonly limit: number;

  constructor(options: { limit?: number } = {}) {
    this.limit = Math.max(2, Math.min(1000, Math.trunc(options.limit ?? 100) || 100));
  }

  snapshot(): { entries: NavigationLocation[]; index: number } {
    return { entries: this.entries.map(copy), index: this.index };
  }

  /** Record a completed jump/current position. Calling this invalidates pending travel. */
  record(location: NavigationLocation): void {
    if (this.disposed) return;
    this.cancel();
    this.append(location);
  }

  /** Refresh the current cursor before history traversal without losing its forward branch. */
  updateCurrent(location: NavigationLocation): void {
    if (this.disposed) return;
    this.cancel();
    if (this.index < 0) this.append(location);
    else this.entries[this.index] = copy(location);
  }

  private append(location: NavigationLocation): void {
    const current = this.entries[this.index];
    if (current && sameLocation(current, location)) {
      this.entries[this.index] = copy(location);
      return;
    }
    this.entries.splice(this.index + 1);
    this.entries.push(copy(location));
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.index = this.entries.length - 1;
  }

  async navigate(location: NavigationLocation, open: OpenLocation, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed) return false;
    const target = copy(location);
    const result = await this.requests.run("navigate", context => open(copy(target), context), signal);
    if (!result || result.value === false) return false;
    this.append(result.value ?? target);
    return true;
  }

  back(open: OpenLocation, signal?: AbortSignal, count = 1): Promise<boolean> {
    return this.travel(-Math.max(1, Math.min(1000, Math.trunc(count) || 1)), open, signal);
  }
  forward(open: OpenLocation, signal?: AbortSignal, count = 1): Promise<boolean> {
    return this.travel(Math.max(1, Math.min(1000, Math.trunc(count) || 1)), open, signal);
  }

  private async travel(delta: number, open: OpenLocation, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed) return false;
    // Even an unavailable direction supersedes an older request.
    this.cancel();
    const next = Math.max(0, Math.min(this.entries.length - 1, this.index + delta));
    if (next === this.index) return false;
    const target = this.entries[next];
    if (!target) return false;
    const result = await this.requests.run(delta < 0 ? "back" : "forward", context => open(copy(target), context), signal);
    if (!result || result.value === false) return false;
    this.index = next;
    if (result.value) this.entries[next] = copy(result.value);
    return true;
  }

  cancel(): void { this.requests.cancel(); }
  dispose(): void { this.disposed = true; this.requests.dispose(); this.entries = []; this.index = -1; }
}
