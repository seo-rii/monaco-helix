import type * as monaco from "monaco-editor";
import type { CommandArguments } from "./commands.js";
import { HostRequestController, NavigationHistory, type HostAdapter, type HostItem, type HostRequestContext, type NavigationLocation } from "./navigation.js";
import { characterSelection, type HelixSelection } from "./selection.js";

export interface NavigationConfiguration { historyLimit?: number; pickerLimit?: number }
export interface HostPickerRequest {
  label: string;
  signal: AbortSignal;
  query(value: string, signal: AbortSignal): Promise<readonly HostItem[]>;
}
export interface HostControllerUI {
  pick(request: HostPickerRequest): Promise<HostItem | undefined>;
  notify(message: string): void;
}
export const HOST_COMMAND_IDS = ["jump_backward", "jump_forward", "file_picker", "buffer_picker", "symbol_picker", "host_command"] as const;

/** Binding-owned workbench coordinator; it never creates or destroys a model. */
export function createHostController(
  editor: monaco.editor.IStandaloneCodeEditor,
  host: HostAdapter,
  ui: HostControllerUI,
  configuration: NavigationConfiguration = {},
) {
  const history = new NavigationHistory({ limit: configuration.historyLimit });
  const requests = new HostRequestController();
  const limit = Math.max(1, Math.min(1000, Math.trunc(configuration.pickerLimit ?? 100) || 100));
  const operations = new Set<AbortController>();
  let trackedModel = editor.getModel();
  let disposed = false;
  let expected: { uri: string; signal: AbortSignal; observed: boolean } | undefined;
  const aborted = () => new DOMException("Host operation cancelled", "AbortError");
  const capture = (): NavigationLocation | undefined => {
    const model = editor.getModel();
    if (disposed || !model || model.isDisposed()) return undefined;
    const text = model.getValue();
    return {
      uri: model.uri.toString(), version: model.getVersionId(),
      selections: (editor.getSelections() ?? []).map(selection => {
        const anchor = model.getOffsetAt(selection.getSelectionStart());
        const head = model.getOffsetAt(selection.getPosition());
        return anchor === head ? characterSelection(text, head) : { anchor, head };
      }),
      viewport: { scrollTop: editor.getScrollTop(), scrollLeft: editor.getScrollLeft() },
    };
  };
  let latest = capture();
  if (latest) history.record(latest);
  const remember = () => { if (editor.getModel() === trackedModel) latest = capture(); };
  const subscriptions = [editor.onDidChangeCursorSelection(remember), editor.onDidScrollChange(remember)];
  const cancel = () => {
    for (const operation of operations) operation.abort();
    operations.clear();
    requests.cancel();
    history.cancel();
    expected = undefined;
  };
  const apply = (location: NavigationLocation): NavigationLocation => {
    const model = editor.getModel();
    if (!model || model.isDisposed() || model.uri.toString() !== location.uri) throw aborted();
    const text = model.getValue();
    const clamp = (offset: number) => Math.max(0, Math.min(text.length, Math.trunc(offset) || 0));
    const normalize = (range: HelixSelection): HelixSelection => {
      const anchor = clamp(range.anchor), head = clamp(range.head);
      if (anchor === head) return characterSelection(text, head);
      const start = characterSelection(text, Math.min(anchor, head)).anchor;
      const stop = Math.max(anchor, head);
      const endPart = characterSelection(text, stop);
      const end = stop === endPart.anchor ? stop : endPart.head;
      return anchor > head ? { anchor: end, head: start } : { anchor: start, head: end };
    };
    const ranges = location.selections.length ? location.selections.map(normalize) : [characterSelection(text, 0)];
    editor.setSelections(ranges.map(range => ({
      selectionStartLineNumber: model.getPositionAt(range.anchor).lineNumber,
      selectionStartColumn: model.getPositionAt(range.anchor).column,
      positionLineNumber: model.getPositionAt(range.head).lineNumber,
      positionColumn: model.getPositionAt(range.head).column,
    })));
    if (location.viewport) editor.setScrollPosition(location.viewport);
    else editor.revealPositionInCenterIfOutsideViewport(model.getPositionAt(ranges[0]!.head));
    editor.focus();
    latest = capture();
    return latest!;
  };
  const open = async (location: NavigationLocation, context: HostRequestContext) => {
    if (context.signal.aborted || disposed) throw aborted();
    if (editor.getModel()?.uri.toString() === location.uri) return apply(location);
    if (!host.openLocation) throw new Error("Host does not support opening another model");
    const navigation = { uri: location.uri, signal: context.signal, observed: false };
    expected = navigation;
    try {
      const actual = await host.openLocation(location, context);
      if (context.signal.aborted || disposed) throw aborted();
      if (actual === false) return false;
      if (editor.getModel()?.uri.toString() !== location.uri) throw new Error("Host did not open the requested URI in this editor");
      return apply(actual ?? location);
    } finally { if (expected === navigation) expected = undefined; }
  };
  const operate = async (signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<void>) => {
    cancel();
    if (disposed || signal?.aborted) throw aborted();
    const operation = new AbortController();
    operations.add(operation);
    // Replacing the old controller during our committed navigation must stop
    // its edits/macros, while this binding-owned navigation may still commit.
    const abort = () => {
      if (expected?.observed && editor.getModel()?.uri.toString() === expected.uri && !expected.signal.aborted) return;
      operation.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await run(operation.signal);
      if (operation.signal.aborted || disposed) throw aborted();
    } finally { operations.delete(operation); signal?.removeEventListener("abort", abort); }
  };
  const command = async (value: string, signal: AbortSignal) => {
    if (!host.executeCommand) throw new Error("Host does not support application commands");
    const result = await requests.run("command", context => host.executeCommand!(value, context), signal);
    if (!result) throw aborted();
  };
  const query = async (capability: NonNullable<HostAdapter["queryFiles"]>, value: string, signal: AbortSignal, owner: AbortSignal) => {
    const combined = new AbortController();
    const abort = () => combined.abort();
    for (const source of [signal, owner]) {
      source.addEventListener("abort", abort, { once: true });
      if (source.aborted) combined.abort();
    }
    try {
      const result = await requests.run("picker", context => capability(value, context), combined.signal);
      if (!result) return [];
      const seen = new Set<string>();
      return result.value.filter(item => {
        if (typeof item.id !== "string" || typeof item.label !== "string" || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, limit);
    } finally { for (const source of [signal, owner]) source.removeEventListener("abort", abort); }
  };
  return {
    capture,
    snapshot: () => history.snapshot(),
    cancel,
    /** Call before disposing the old model-specific editor controller. */
    onModelChange(): boolean {
      const next = editor.getModel();
      if (expected && !expected.signal.aborted && next?.uri.toString() === expected.uri) {
        expected.observed = true;
        trackedModel = next;
        latest = capture();
        return true;
      }
      cancel();
      if (latest) history.record(latest);
      trackedModel = next;
      latest = capture();
      if (latest) history.record(latest);
      return false;
    },
    /** Record explicit same-model jumps without recording ordinary cursor motion. */
    record(location = capture()): void { if (location) history.record(location); },
    async execute(id: string, args: CommandArguments = {}, signal?: AbortSignal): Promise<void> {
      if (!(HOST_COMMAND_IDS as readonly string[]).includes(id)) throw new Error(`Unknown host command: ${id}`);
      await operate(signal, async active => {
        if (id === "host_command") {
          const value = String(args.command ?? "").trim();
          if (!value) throw new Error("Host command must not be empty");
          await command(value, active);
          return;
        }
        if (id === "jump_backward" || id === "jump_forward") {
          const source = capture();
          if (source) history.updateCurrent(source);
          const count = Math.max(1, Math.min(1000, Math.trunc(Number(args.count)) || 1));
          const succeeded = await (id === "jump_backward" ? history.back(open, active, count) : history.forward(open, active, count));
          if (!succeeded && !active.aborted) ui.notify(id === "jump_backward" ? "No earlier jump" : "No later jump");
          return;
        }
        const capability = id === "file_picker" ? host.queryFiles : id === "buffer_picker" ? host.listBuffers : host.querySymbols;
        const label = id === "file_picker" ? "Files" : id === "buffer_picker" ? "Buffers" : "Symbols";
        if (!capability) throw new Error(`Host does not support ${label.toLowerCase()}`);
        const item = await ui.pick({ label, signal: active, query: (value, request) => query(capability, value, request, active) });
        if (active.aborted) throw aborted();
        if (!item) throw aborted();
        if (item.location) {
          const source = capture();
          if (source) history.record(source);
          const succeeded = await history.navigate(item.location, open, active);
          if (!succeeded) {
            if (active.aborted) throw aborted();
            throw new Error("Selected location is unavailable");
          }
        } else if (item.command) await command(item.command, active);
        else throw new Error("Picker item has no location or command");
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancel();
      for (const subscription of subscriptions) subscription.dispose();
      requests.dispose();
      history.dispose();
      latest = undefined;
    },
  };
}
