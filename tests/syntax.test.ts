import { describe, expect, it, vi } from "vitest";
import { SyntaxCoordinator } from "../src/syntax.js";
import type { SyntaxProvider, SyntaxResult } from "../src/syntax.js";

const document = { id: "model-1", version: 1, languageId: "python", text: "a👩‍💻b\r\n한글" };
const ranges = [{ anchor: 0, head: 1 }];
const operation = { kind: "parent" } as const;

describe("versioned syntax coordinator", () => {
  it("discards an older response even when a provider ignores abort", async () => {
    const pending: ((value: SyntaxResult) => void)[] = [];
    const signals: AbortSignal[] = [];
    const provider: SyntaxProvider = { provide: request => { signals.push(request.signal); return new Promise(resolve => pending.push(resolve)); } };
    const coordinator = new SyntaxCoordinator(provider);
    const first = coordinator.query(document, ranges, operation);
    const second = coordinator.query({ ...document, version: 2 }, ranges, operation);
    expect(signals[0].aborted).toBe(true);
    pending[1]({ version: 2, selections: [{ anchor: 0, head: 6 }] });
    expect(await second).toEqual([{ anchor: 0, head: 6 }]);
    pending[0]({ version: 1, selections: [{ anchor: 0, head: 1 }] });
    expect(await first).toBeNull();
    coordinator.dispose();
  });

  it("rejects a provider result for another model version", async () => {
    const coordinator = new SyntaxCoordinator({ provide: async () => ({ version: 9, selections: ranges }) });
    expect(await coordinator.query(document, ranges, operation)).toBeNull();
    coordinator.dispose();
  });

  it.each([-1, 1000, NaN, Infinity, 0.5])("rejects unsafe result offset %s", async offset => {
    const coordinator = new SyntaxCoordinator({ provide: async () => ({ version: 1, selections: [{ anchor: offset, head: 1 }] }) });
    expect(await coordinator.query(document, ranges, operation)).toBeNull();
  });

  it("expands partial graphemes and preserves direction", async () => {
    const coordinator = new SyntaxCoordinator({ provide: async () => ({ version: 1, selections: [{ anchor: 5, head: 2 }] }) });
    expect(await coordinator.query(document, ranges, operation)).toEqual([{ anchor: 6, head: 1 }]);
  });

  it("snapshots host inputs and releases each visited model without disposing a shared provider", async () => {
    const release = vi.fn(); const dispose = vi.fn();
    const input = { ...document }; const selections = [{ anchor: 0, head: 1 }];
    let resolve!: (value: SyntaxResult) => void;
    const provider: SyntaxProvider = { release, dispose, provide: request => {
      expect(request.document).not.toBe(input); expect(request.selections).not.toBe(selections);
      return new Promise(done => { resolve = done; });
    } };
    const coordinator = new SyntaxCoordinator(provider);
    const result = coordinator.query(input, selections, operation);
    input.version = 2; selections[0].head = 100;
    resolve({ version: 1, selections: ranges });
    expect(await result).toEqual(ranges);
    coordinator.dispose(); coordinator.dispose();
    expect(release).toHaveBeenCalledExactlyOnceWith("model-1");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("discards a late result after model release or external abort", async () => {
    let resolve!: (value: SyntaxResult) => void;
    const release = vi.fn();
    const coordinator = new SyntaxCoordinator({ release, provide: () => new Promise(done => { resolve = done; }) });
    const signal = new AbortController();
    const result = coordinator.query(document, ranges, operation, signal.signal);
    signal.abort(); coordinator.release(document.id);
    resolve({ version: 1, selections: ranges });
    expect(await result).toBeNull(); expect(release).toHaveBeenCalledOnce();
  });

  it("reports current errors but suppresses errors from aborted work", async () => {
    const coordinator = new SyntaxCoordinator({ provide: async () => { throw new Error("parser unavailable"); } });
    await expect(coordinator.query(document, ranges, operation)).rejects.toThrow("parser unavailable");
    const result = coordinator.query(document, ranges, operation); coordinator.cancel();
    expect(await result).toBeNull();
  });

  it("settles cancellation even when a third-party provider never resolves", async () => {
    const coordinator = new SyntaxCoordinator({ provide: () => new Promise(() => undefined) });
    const result = coordinator.query(document, ranges, operation);
    coordinator.cancel();
    expect(await result).toBeNull();
    coordinator.dispose();
  });
});
