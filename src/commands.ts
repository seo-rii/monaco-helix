export interface CommandInfo {
  id: string;
  description: string;
  mutates?: boolean;
  keys?: readonly string[];
}
export interface CommandArguments { count?: number; character?: string; [key: string]: unknown }
export interface CommandContext { signal: AbortSignal; assertCurrent(): void }
export type CommandHandler = (args: CommandArguments, context: CommandContext) => void | Promise<void>;

export function cancellation(): Error { return new DOMException("Command cancelled", "AbortError"); }
export function isCancellation(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }

/** Executes synchronous edits immediately, and serializes asynchronous selections and edits. */
export class CommandDispatcher {
  private handlers = new Map<string, { info: CommandInfo; run: CommandHandler }>();
  private pending: Array<{ id: string; args: CommandArguments; signal?: AbortSignal; resolve(): void; reject(error: unknown): void }> = [];
  private active?: AbortController;
  private idleWaiters: Array<{resolve(): void; reject(error: unknown): void}> = [];
  private disposed = false;
  constructor(private available: () => boolean, private readOnly: () => boolean) {}
  register(info: CommandInfo, run: CommandHandler): void {
    if (this.handlers.has(info.id)) throw new Error(`Duplicate command: ${info.id}`);
    this.handlers.set(info.id, { info: { ...info }, run });
  }
  list(): CommandInfo[] { return [...this.handlers.values()].map(item => ({ ...item.info })); }
  idle(): Promise<void> {
    if (!this.active && !this.pending.length) return Promise.resolve();
    return new Promise((resolve, reject) => this.idleWaiters.push({ resolve, reject }));
  }
  execute(id: string, args: CommandArguments = {}, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed || signal?.aborted) { reject(cancellation()); return; }
      this.pending.push({ id, args, signal, resolve, reject });
      this.drain();
    });
  }
  private drain(): void {
    if (this.active || this.disposed) return;
    const job = this.pending.shift();
    if (!job) return;
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    job.signal?.addEventListener("abort", abort, { once: true });
    const finish = (error?: unknown) => {
      job.signal?.removeEventListener("abort", abort);
      const owned = this.active === controller;
      if (owned) this.active = undefined;
      if (error) {
        if (owned) for (const next of this.pending.splice(0)) next.reject(cancellation());
        job.reject(error);
      } else job.resolve();
      if (owned) this.drain();
      if (owned && !this.active && !this.pending.length) {
        for (const waiter of this.idleWaiters.splice(0)) {
          if (error) waiter.reject(error); else waiter.resolve();
        }
      }
    };
    const assertCurrent = () => {
      if (this.disposed || controller.signal.aborted || job.signal?.aborted || !this.available()) throw cancellation();
    };
    try {
      assertCurrent();
      const command = this.handlers.get(job.id);
      if (!command) throw new Error(`Unknown command: ${job.id}`);
      if (command.info.mutates && this.readOnly()) throw new Error("Read-only editor");
      const result = command.run(job.args, { signal: controller.signal, assertCurrent });
      if (!result || typeof result.then !== "function") { finish(); return; }
      let onAbort: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(cancellation());
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      void Promise.race([result, cancelled]).then(() => { assertCurrent(); finish(); }, error => {
        // A failed async selection must never release queued destructive edits
        // onto the previous selection.
        if (this.active === controller) for (const next of this.pending.splice(0)) next.reject(cancellation());
        finish(error);
      }).catch(error => finish(error)).finally(() => {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      });
    } catch (error) { finish(error); }
  }
  cancel(): void {
    for (const job of this.pending.splice(0)) job.reject(cancellation());
    const active = this.active;
    this.active = undefined;
    active?.abort();
    for (const waiter of this.idleWaiters.splice(0)) waiter.reject(cancellation());
  }
  dispose(): void { this.disposed = true; this.cancel(); this.handlers.clear(); }
}
