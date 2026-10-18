import { describe, expect, it } from "vitest";
import { CommandDispatcher } from "../src/commands.js";

describe("command execution", () => {
  it("orders accepted prompt operations with registered edits", async () => {
    const runner = new CommandDispatcher(() => true, () => false);
    const events: string[] = [];
    let finish!: () => void;
    const selected = runner.run(() => new Promise<void>(resolve => {
      finish = () => { events.push("selected"); resolve(); };
    }));
    runner.register({ id: "edit", description: "edit" }, () => { events.push("edited"); });
    const edited = runner.execute("edit");
    expect(runner.isBusy).toBe(true);
    expect(events).toEqual([]);
    finish();
    await Promise.all([selected, edited]);
    expect(runner.isBusy).toBe(false);
    expect(events).toEqual(["selected", "edited"]);
  });
  it("discards edits after an ordered prompt operation fails or is cancelled", async () => {
    const runner = new CommandDispatcher(() => true, () => false);
    let edits = 0;
    runner.register({ id: "edit", description: "edit" }, () => { edits++; });
    const failed = runner.run(async () => { throw new Error("Search failed"); });
    const stale = runner.execute("edit");
    await expect(failed).rejects.toThrow("Search failed");
    await expect(stale).rejects.toHaveProperty("name", "AbortError");
    let operationSignal!: AbortSignal;
    const cancelled = runner.run(context => {
      operationSignal = context.signal;
      return new Promise<void>(() => {});
    });
    const queued = runner.execute("edit");
    runner.cancel();
    await expect(cancelled).rejects.toHaveProperty("name", "AbortError");
    await expect(queued).rejects.toHaveProperty("name", "AbortError");
    expect(operationSignal.aborted).toBe(true);
    await runner.execute("edit");
    expect(edits).toBe(1);
  });
  it("runs synchronous edits immediately and rejects unknown/read-only commands", async () => {
    let changed = 0;
    let readOnly = false;
    const runner = new CommandDispatcher(() => true, () => readOnly);
    runner.register({ id: "edit", description: "edit", mutates: true }, () => { changed++; });
    const first = runner.execute("edit");
    expect(changed).toBe(1);
    await first;
    readOnly = true;
    await expect(runner.execute("edit")).rejects.toThrow("Read-only");
    await expect(runner.execute("missing")).rejects.toThrow("Unknown");
    expect(changed).toBe(1);
  });
  it("waits for a selection before editing", async () => {
    const runner = new CommandDispatcher(() => true, () => false);
    const events: string[] = [];
    let finish!: () => void;
    runner.register({ id: "select", description: "select" }, () => new Promise<void>(resolve => { finish = () => { events.push("selected"); resolve(); }; }));
    runner.register({ id: "delete", description: "delete" }, () => { events.push("deleted"); });
    const selection = runner.execute("select");
    const edit = runner.execute("delete");
    expect(events).toEqual([]);
    finish();
    await Promise.all([selection, edit]);
    expect(events).toEqual(["selected", "deleted"]);
  });
  it("discards queued destructive edits after selection failure", async () => {
    const runner = new CommandDispatcher(() => true, () => false);
    let edited = false;
    runner.register({ id: "select", description: "select" }, async () => { throw new Error("no syntax"); });
    runner.register({ id: "delete", description: "delete" }, () => { edited = true; });
    const selection = runner.execute("select");
    const edit = runner.execute("delete");
    await expect(selection).rejects.toThrow("no syntax");
    await expect(edit).rejects.toHaveProperty("name", "AbortError");
    expect(edited).toBe(false);
  });
  it("cancels active work and queued work even when the provider ignores cancellation", async () => {
    const runner = new CommandDispatcher(() => true, () => false);
    runner.register({ id: "wait", description: "wait" }, () => new Promise<void>(() => {}));
    const active = runner.execute("wait");
    const queued = runner.execute("wait");
    runner.cancel();
    await expect(active).rejects.toHaveProperty("name", "AbortError");
    await expect(queued).rejects.toHaveProperty("name", "AbortError");
    runner.dispose();
    await expect(runner.execute("wait")).rejects.toHaveProperty("name", "AbortError");
  });
  it("allows a fresh command immediately after cancellation", async () => {
    const runner = new CommandDispatcher(() => true, () => false);
    runner.register({ id: "wait", description: "wait" }, () => new Promise<void>(() => {}));
    let changed = 0;
    runner.register({ id: "edit", description: "edit" }, () => { changed++; });
    const old = runner.execute("wait");
    runner.cancel();
    await runner.execute("edit");
    await expect(old).rejects.toHaveProperty("name", "AbortError");
    expect(changed).toBe(1);
  });
});
