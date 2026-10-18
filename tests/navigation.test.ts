import { describe, expect, it } from "vitest";
import { HostRequestController, NavigationHistory, type NavigationLocation, type OpenLocation } from "../src/navigation.js";

const location = (uri: string, anchor = 0, head = anchor + 1): NavigationLocation => ({
  uri, selections: [{ anchor, head }], version: 1, viewport: { scrollTop: 10, scrollLeft: 20 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("navigation history", () => {
  it("copies directional selections and viewport without retaining caller-owned data", () => {
    const history = new NavigationHistory();
    const source = location("file:a", 8, 2);
    history.record(source);
    source.selections[0]!.head = 100;
    source.viewport!.scrollTop = 100;
    const snapshot = history.snapshot();
    expect(snapshot.entries[0]).toEqual(location("file:a", 8, 2));
    snapshot.entries[0]!.selections[0]!.anchor = 100;
    expect(history.snapshot().entries[0]!.selections[0]!.anchor).toBe(8);
  });

  it("suppresses consecutive duplicates while refreshing model version and scroll", () => {
    const history = new NavigationHistory();
    history.record(location("file:a"));
    history.record({ ...location("file:a"), version: 2, viewport: { scrollTop: 90, scrollLeft: 0 } });
    expect(history.snapshot().entries).toHaveLength(1);
    expect(history.snapshot().entries[0]!.version).toBe(2);
  });

  it("travels both directions and branches after recording a new location", async () => {
    const history = new NavigationHistory();
    for (const uri of ["a", "b", "c"]) history.record(location(uri));
    const visited: string[] = [];
    const open: OpenLocation = target => { visited.push(target.uri); };
    expect(await history.back(open)).toBe(true);
    expect(await history.back(open)).toBe(true);
    expect(await history.back(open)).toBe(false);
    expect(await history.forward(open)).toBe(true);
    history.record(location("d"));
    expect(await history.forward(open)).toBe(false);
    expect(visited).toEqual(["b", "a", "b"]);
    expect(history.snapshot()).toEqual({ entries: [location("a"), location("b"), location("d")], index: 2 });
  });

  it("bounds history and keeps the current position", () => {
    const history = new NavigationHistory({ limit: 2 });
    for (const uri of ["a", "b", "c"]) history.record(location(uri));
    expect(history.snapshot()).toEqual({ entries: [location("b"), location("c")], index: 1 });
  });

  it("commits only accepted host navigation and keeps corrected locations", async () => {
    const history = new NavigationHistory();
    history.record(location("a"));
    expect(await history.navigate(location("missing"), () => false)).toBe(false);
    expect(history.snapshot().index).toBe(0);
    expect(await history.navigate(location("b", 80), () => location("b", 3))).toBe(true);
    expect(history.snapshot().entries[1]).toEqual(location("b", 3));
    expect(await history.back(() => false)).toBe(false);
    expect(history.snapshot().index).toBe(1);
    await expect(history.back(() => { throw new Error("host offline"); })).rejects.toThrow("host offline");
    expect(history.snapshot().index).toBe(1);
  });

  it("ignores stale reverse-order responses even when a host ignores its signal", async () => {
    const history = new NavigationHistory();
    history.record(location("a"));
    const first = deferred<void>();
    let oldSignal!: AbortSignal;
    const old = history.navigate(location("b"), (_target, context) => { oldSignal = context.signal; return first.promise; });
    expect(await history.navigate(location("c"), () => undefined)).toBe(true);
    expect(oldSignal.aborted).toBe(true);
    first.resolve();
    expect(await old).toBe(false);
    expect(history.snapshot().entries.map(entry => entry.uri)).toEqual(["a", "c"]);
  });

  it("cancels pending travel on external record, abort, and editor disposal", async () => {
    const history = new NavigationHistory();
    history.record(location("a"));
    history.record(location("b"));
    const first = deferred<void>();
    const old = history.back(() => first.promise);
    history.record(location("external"));
    first.resolve();
    expect(await old).toBe(false);
    const signal = new AbortController();
    const second = deferred<void>();
    const aborted = history.back(() => second.promise, signal.signal);
    signal.abort();
    second.resolve();
    expect(await aborted).toBe(false);
    const third = deferred<void>();
    const disposed = history.back(() => third.promise);
    history.dispose();
    third.resolve();
    expect(await disposed).toBe(false);
    expect(history.snapshot()).toEqual({ entries: [], index: -1 });
    expect(await history.navigate(location("after"), () => undefined)).toBe(false);
  });
});

describe("host request controller", () => {
  it("settles cancellation even if a host never resolves its operation", async () => {
    const requests = new HostRequestController();
    const pending = requests.run("never", () => new Promise<never>(() => {}));
    requests.cancel();
    expect(await pending).toBeUndefined();
  });

  it("aborts superseded pickers and suppresses their late errors", async () => {
    const requests = new HostRequestController();
    const first = deferred<string[]>();
    let oldSignal!: AbortSignal;
    const old = requests.run("files", context => { oldSignal = context.signal; return first.promise; });
    expect(await requests.run("symbols", () => ["new"])).toEqual({ value: ["new"] });
    expect(oldSignal.aborted).toBe(true);
    first.reject(new Error("late failure"));
    expect(await old).toBeUndefined();
    requests.dispose();
    expect(await requests.run("after-close", () => ["no"])).toBeUndefined();
  });
});
