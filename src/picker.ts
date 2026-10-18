import type { HostPickerRequest } from "./host-controller.js";
import type { HostItem } from "./navigation.js";
import type { ModalUI, PromptOptions } from "./types.js";

let pickerId = 0;

/** Accessible host picker built on the same prompt lifetime and macro bridge as search. */
export function createHostPicker(ui: ModalUI, container: HTMLElement, options: { isReplaying?: () => boolean } = {}) {
  return (request: HostPickerRequest): Promise<HostItem | undefined> => new Promise((resolve, reject) => {
    const document = container.ownerDocument;
    const list = document.createElement("div");
    list.className = "monaco-helix-picker";
    list.id = `monaco-helix-picker-${++pickerId}`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", `${request.label} results`);
    let input: HTMLInputElement | undefined;
    let items: readonly HostItem[] = [];
    let selected = 0;
    let queryValue = "";
    let queryId = 0;
    let settled = false;
    let composing = false;
    const initial = new AbortController();
    const cancelled = () => new DOMException("Picker cancelled", "AbortError");
    const current = () => !settled && !request.signal.aborted;
    const render = (loading = false) => {
      list.replaceChildren();
      items.forEach((item, index) => {
        const option = document.createElement("div");
        option.id = `${list.id}-${index}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === selected));
        option.addEventListener("mousedown", event => event.preventDefault());
        option.addEventListener("click", () => {
          if (!current() || !input) return;
          selected = index;
          render();
          void ui.submitPrompt?.(input.value, request.label).catch(error => ui.error(error));
        });
        const title = document.createElement("span");
        title.textContent = item.label;
        option.append(title);
        if (item.description) {
          const description = document.createElement("small");
          description.textContent = item.description;
          option.append(description);
        }
        list.append(option);
      });
      if (!items.length) {
        const empty = document.createElement("div");
        empty.textContent = loading ? "Searching…" : "No results";
        list.append(empty);
      }
      if (items[selected]) {
        input?.setAttribute("aria-activedescendant", `${list.id}-${selected}`);
        list.children[selected]?.scrollIntoView({ block: "nearest" });
      } else input?.removeAttribute("aria-activedescendant");
    };
    const cleanup = () => {
      initial.abort();
      queryId++;
      request.signal.removeEventListener("abort", abort);
      input?.removeEventListener("keydown", keydown, true);
      input?.removeEventListener("input", change);
      input?.removeEventListener("compositionstart", compositionStart);
      input?.removeEventListener("compositionend", compositionEnd);
      list.remove();
    };
    const finish = (item?: HostItem, error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(item);
    };
    const abort = () => {
      finish();
      // Resolve our owner before closing UI: promptSettled can await that owner.
      if (ui.promptActive?.()) void ui.submitPrompt?.("", request.label, true).catch(error => ui.error(error));
    };
    const load = async (value: string, signal: AbortSignal) => {
      const id = ++queryId;
      queryValue = value;
      render(true);
      const result = await request.query(value, signal);
      if (!current() || signal.aborted || id !== queryId) return;
      const previous = items[selected]?.id;
      items = result;
      selected = Math.max(0, items.findIndex(item => item.id === previous));
      render();
      ui.notify(`${items.length} results`);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || composing || !items.length) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      render();
    };
    const change = () => { initial.abort(); queryId++; selected = 0; items = []; render(true); };
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => { composing = false; };
    const config: PromptOptions & { record: boolean } = {
      record: false,
      onChange: load,
      onCancel() {
        if (!request.signal.aborted) ui.recordPrompt?.(JSON.stringify({ query: input?.value ?? queryValue, selectedId: null }), request.label, true);
        finish();
      },
    };
    ui.prompt(request.label, async value => {
      try {
        if (!current()) throw cancelled();
        initial.abort();
        queryId++;
        let query = value;
        let selectedId = queryValue === value ? items[selected]?.id : undefined;
        let replay = false;
        try {
          const payload: unknown = JSON.parse(value);
          if (payload && typeof payload === "object" && "query" in payload && "selectedId" in payload
            && typeof payload.query === "string" && typeof payload.selectedId === "string") {
            query = payload.query;
            selectedId = payload.selectedId;
            replay = true;
          }
        } catch { /* Ordinary interactive queries need not be JSON. */ }
        if (options.isReplaying?.() && !replay) throw new Error("Picker macro response requires query and selectedId");
        const available = await request.query(query, request.signal);
        if (!current()) throw cancelled();
        const choice = selectedId === undefined && !replay ? available[0] : available.find(item => item.id === selectedId);
        if (!choice) throw new Error(replay ? "Recorded picker target is not available" : "Selected picker target is not available");
        ui.recordPrompt?.(JSON.stringify({ query, selectedId: choice.id }), request.label, false);
        finish(choice);
      } catch (error) { finish(undefined, error); throw error; }
    }, "", config);
    input = container.querySelector<HTMLInputElement>("input") ?? undefined;
    if (!input) { finish(undefined, new Error("Host picker requires a mounted prompt")); return; }
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", list.id);
    input.addEventListener("keydown", keydown, true);
    input.addEventListener("input", change);
    input.addEventListener("compositionstart", compositionStart);
    input.addEventListener("compositionend", compositionEnd);
    container.append(list);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    render(true);
    void load("", initial.signal).catch(error => {
      if (current() && !initial.signal.aborted) ui.error(error);
    });
  });
}
