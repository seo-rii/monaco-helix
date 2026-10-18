/** Framework-free key notation, validation and mode-specific keymap lookup. */
export type KeymapMode = "normal" | "insert" | "select";

export interface KeymapTree {
  [key: string]: KeymapValue;
}

/** null removes an inherited binding; pass_through delegates the key to Monaco. */
export type KeymapValue = string | readonly string[] | KeymapTree | null;
export type Keymaps = Partial<Record<KeymapMode, KeymapTree>>;

export interface KeymapDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export type KeyBinding =
  | { kind: "commands"; commands: string[] }
  | { kind: "macro"; keys: string[] }
  | { kind: "pass" }
  | { kind: "unbound"; explicit: true };

export type KeymapLookup = KeyBinding
  | { kind: "pending"; next: string[] }
  | { kind: "unbound"; explicit: false };

export interface KeymapEntry {
  keys: string[];
  binding: KeyBinding;
}

export interface KeymapOptions {
  /** Omit to accept application-defined command names. Colon commands are host commands. */
  commands?: Iterable<string>;
  maxDepth?: number;
  maxBindings?: number;
}

export interface KeymapUpdate {
  ok: boolean;
  diagnostics: KeymapDiagnostic[];
}

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  getModifierState?: (key: string) => boolean;
}

const namedKeys: Record<string, string> = {
  esc: "esc", escape: "esc", ret: "ret", enter: "ret", return: "ret",
  backspace: "backspace", bs: "backspace", tab: "tab", space: "space",
  left: "left", arrowleft: "left", right: "right", arrowright: "right",
  up: "up", arrowup: "up", down: "down", arrowdown: "down",
  home: "home", end: "end", pageup: "pageup", pagedown: "pagedown",
  del: "del", delete: "del", ins: "ins", insert: "ins", null: "null",
  minus: "-", lt: "<", gt: ">",
};
const modifiers: Record<string, "C" | "A" | "S" | "Cmd"> = {
  c: "C", ctrl: "C", control: "C", a: "A", alt: "A", option: "A",
  s: "S", shift: "S", cmd: "Cmd", meta: "Cmd", win: "Cmd", super: "Cmd",
};
const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const modes: KeymapMode[] = ["normal", "insert", "select"];

/** Normalize one Helix-style key; uppercase printable letters remain distinct. */
export function normalizeKey(input: string): string {
  if (typeof input !== "string" || !input) throw new Error("A key must be a non-empty string");
  if (input === " ") return "space";
  if (input === "\n" || input === "\r" || input === "\r\n") return "ret";
  if (input === "\t") return "tab";
  let remaining = input;
  const flags = new Set<string>();
  while (remaining.includes("-")) {
    const separator = remaining.indexOf("-");
    const name = remaining.slice(0, separator).toLowerCase();
    const modifier = Object.hasOwn(modifiers, name) ? modifiers[name] : undefined;
    if (!modifier) break;
    if (flags.has(modifier)) throw new Error(`Duplicate modifier in key ${JSON.stringify(input)}`);
    flags.add(modifier);
    remaining = remaining.slice(separator + 1);
    if (!remaining || remaining === "-") throw new Error("Use minus for a modified '-' key");
  }
  const name = remaining.toLowerCase();
  let base = Object.hasOwn(namedKeys, name) ? namedKeys[name] : undefined;
  if (!base && /^f(?:[1-9]|[12]\d|3[0-5])$/i.test(remaining)) base = remaining.toLowerCase();
  if (!base) {
    const part = characters.segment(remaining).containing(0);
    if (!part || part.segment.length !== remaining.length || /[\u0000-\u001f\u007f]/u.test(remaining)) {
      throw new Error(`Unknown key ${JSON.stringify(input)}`);
    }
    base = remaining;
  }
  if (/^[a-zA-Z]$/.test(base)) {
    if (flags.has("C") || flags.has("A") || flags.has("Cmd")) {
      if (base !== base.toLowerCase()) flags.add("S");
      base = base.toLowerCase();
    } else if (flags.delete("S")) base = base.toUpperCase();
  } else if (Array.from(base).length === 1) {
    // For printable punctuation the produced character already encodes Shift.
    if (flags.has("S")) {
      const shifted: Record<string, string> = {
        "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^",
        "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+",
        "[": "{", "]": "}", "\\": "|", ";": ":", "'": '"', ",": "<",
        ".": ">", "/": "?", "`": "~",
      };
      base = shifted[base] ?? base;
    }
    flags.delete("S");
  }
  if (flags.size && base === "-") base = "minus";
  const prefix = ["C", "A", "S", "Cmd"].filter(flag => flags.has(flag));
  return [...prefix, base].join("-");
}

/** Normalize browser input without interpreting IME composition or AltGraph as commands. */
export function keyFromEvent(event: KeyEventLike): string | null {
  if (event.isComposing || event.getModifierState?.("AltGraph")) return null;
  let key = event.key;
  if (["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Process", "Unidentified"].includes(key)) return null;
  // macOS Option produces alternate glyphs/dead keys. Existing Helix Alt
  // shortcuts use the physical key in that case, while ordinary text uses key.
  if (event.altKey && event.code) {
    if (/^Key[A-Z]$/.test(event.code)) key = event.shiftKey ? event.code.slice(3) : event.code.slice(3).toLowerCase();
    else {
      const punctuation: Record<string, [string, string]> = {
        Semicolon: [";", ":"], Minus: ["-", "_"], Period: [".", ">"],
        Comma: [",", "<"], Quote: ["'", '"'], Backquote: ["`", "~"],
        BracketLeft: ["[", "{"], BracketRight: ["]", "}"],
        Backslash: ["\\", "|"], Slash: ["/", "?"], Equal: ["=", "+"],
      };
      const pair = punctuation[event.code];
      if (pair) key = pair[event.shiftKey ? 1 : 0];
    }
  }
  if (key === "Dead") return null;
  const prefix = [event.ctrlKey && "C", event.altKey && "A", event.shiftKey && "S", event.metaKey && "Cmd"].filter(Boolean);
  // Normalize the base first so literal '-' is represented unambiguously.
  let base: string;
  try { base = normalizeKey(key); } catch { return null; }
  if (prefix.length && base === "-") base = "minus";
  try { return normalizeKey([...prefix, base].join("-")); } catch { return null; }
}

/** Decode the body of a Helix @ macro, e.g. miw<A-x><esc>. */
export function decodeKeys(input: string): string[] {
  const result: string[] = [];
  const segments = characters.segment(input);
  for (let offset = 0; offset < input.length;) {
    if (input[offset] === "<") {
      const end = input.indexOf(">", offset + 1);
      if (end < 0) throw new Error(`Unclosed macro key at offset ${offset}`);
      result.push(normalizeKey(input.slice(offset + 1, end)));
      offset = end + 1;
    } else {
      const part = segments.containing(offset)!;
      result.push(normalizeKey(part.segment));
      offset += part.segment.length;
    }
  }
  return result;
}

/** Encode normalized keys; literal '<' is written as <lt>. */
export function encodeKeys(keys: readonly string[]): string {
  return keys.map(key => {
    const normalized = normalizeKey(key);
    if (normalized === "<") return "<lt>";
    const part = characters.segment(normalized).containing(0)!;
    return part.segment.length === normalized.length ? normalized : `<${normalized}>`;
  }).join("");
}

interface TrieNode {
  children: Map<string, TrieNode>;
  binding?: KeyBinding;
}

function cloneNode(node: TrieNode): TrieNode {
  return {
    children: new Map([...node.children].map(([key, child]) => [key, cloneNode(child)])),
    ...(node.binding ? { binding: copyBinding(node.binding) } : {}),
  };
}

function copyBinding(binding: KeyBinding): KeyBinding {
  if (binding.kind === "commands") return { kind: "commands", commands: [...binding.commands] };
  if (binding.kind === "macro") return { kind: "macro", keys: [...binding.keys] };
  return { ...binding };
}

export class KeymapError extends Error {
  constructor(readonly diagnostics: KeymapDiagnostic[]) {
    super(diagnostics.map(item => `${item.path}: ${item.message}`).join("\n"));
    this.name = "KeymapError";
  }
}

/** Immutable-after-validation lookup tables with atomic override replacement. */
export class KeymapEngine {
  private defaults = new Map<KeymapMode, TrieNode>();
  private roots = new Map<KeymapMode, TrieNode>();
  private commands: Set<string> | undefined;
  private version = 0;
  private maxDepth: number;
  private maxBindings: number;

  constructor(defaults: Keymaps = {}, options: KeymapOptions = {}) {
    this.commands = options.commands ? new Set(options.commands) : undefined;
    this.maxDepth = options.maxDepth ?? 32;
    this.maxBindings = options.maxBindings ?? 10_000;
    if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth < 1 || this.maxDepth > 256) throw new Error("maxDepth must be an integer from 1 to 256");
    if (!Number.isSafeInteger(this.maxBindings) || this.maxBindings < 1) throw new Error("maxBindings must be a positive safe integer");
    const result = this.compile(defaults, new Map());
    if (result.diagnostics.some(item => item.severity === "error")) throw new KeymapError(result.diagnostics);
    this.defaults = result.roots;
    this.roots = new Map([...this.defaults].map(([mode, node]) => [mode, cloneNode(node)]));
  }

  get revision(): number { return this.version; }

  replace(overrides: Keymaps): KeymapUpdate {
    const base = new Map([...this.defaults].map(([mode, node]) => [mode, cloneNode(node)]));
    const result = this.compile(overrides, base);
    const ok = !result.diagnostics.some(item => item.severity === "error");
    if (ok) { this.roots = result.roots; this.version++; }
    return { ok, diagnostics: result.diagnostics };
  }

  lookup(mode: KeymapMode, sequence: readonly string[]): KeymapLookup {
    let node = this.roots.get(mode);
    for (const input of sequence) {
      node = node?.children.get(normalizeKey(input));
      if (!node) return { kind: "unbound", explicit: false };
    }
    if (!node) return { kind: "unbound", explicit: false };
    if (node.binding) return copyBinding(node.binding);
    return node.children.size
      ? { kind: "pending", next: [...node.children.keys()] }
      : { kind: "unbound", explicit: false };
  }

  /** Read-only snapshots suitable for help UIs; mutating them cannot change lookup. */
  list(mode: KeymapMode, prefix: readonly string[] = []): KeymapEntry[] {
    let node = this.roots.get(mode);
    const normalized = prefix.map(normalizeKey);
    for (const key of normalized) node = node?.children.get(key);
    const result: KeymapEntry[] = [];
    const visit = (current: TrieNode, keys: string[]) => {
      if (current.binding) result.push({ keys, binding: copyBinding(current.binding) });
      for (const [key, child] of current.children) visit(child, [...keys, key]);
    };
    if (node) visit(node, normalized);
    return result;
  }

  private compile(input: Keymaps, roots: Map<KeymapMode, TrieNode>) {
    const diagnostics: KeymapDiagnostic[] = [];
    let bindings = 0;
    const active = new WeakSet<object>();
    const problem = (path: string, code: string, message: string) => diagnostics.push({ severity: "error" as const, path, code, message });
    const command = (value: string, path: string): string | undefined => {
      const normalized = value.trim();
      if (!normalized) { problem(path, "empty_command", "Commands must not be empty"); return; }
      if (normalized.startsWith(":")) {
        if (!normalized.slice(1).trim()) { problem(path, "empty_command", "A colon command needs a command name"); return; }
      } else if (normalized !== "no_op" && this.commands && !this.commands.has(normalized)) {
        problem(path, "unknown_command", `Unsupported command ${JSON.stringify(normalized)}`);
        return;
      }
      return normalized;
    };
    const valueNode = (value: unknown, path: string, old: TrieNode | undefined, depth: number): TrieNode | undefined => {
      if (depth > 0 && ++bindings > this.maxBindings) { problem(path, "binding_limit", `Keymaps exceed ${this.maxBindings} bindings`); return; }
      if (depth > this.maxDepth) { problem(path, "depth_limit", `Keymaps exceed ${this.maxDepth} nested keys`); return; }
      if (value === null) return { children: new Map(), binding: { kind: "unbound", explicit: true } };
      if (typeof value === "string") {
        if (value === "pass_through") return { children: new Map(), binding: { kind: "pass" } };
        if (value.startsWith("@")) {
          try {
            const keys = decodeKeys(value.slice(1));
            if (!keys.length) { problem(path, "empty_macro", "A key macro needs at least one key"); return; }
            return { children: new Map(), binding: { kind: "macro", keys } };
          } catch (error) { problem(path, "invalid_macro", error instanceof Error ? error.message : String(error)); return; }
        }
        const name = command(value, path);
        return name ? { children: new Map(), binding: { kind: "commands", commands: [name] } } : undefined;
      }
      if (Array.isArray(value)) {
        if (!value.length) { problem(path, "empty_sequence", "A command sequence must not be empty"); return; }
        const names: string[] = [];
        value.forEach((item, index) => {
          const itemPath = `${path}[${index}]`;
          if (typeof item !== "string") problem(itemPath, "invalid_command", "A command sequence contains only strings");
          else if (item.startsWith("@") || item === "pass_through") problem(itemPath, "invalid_sequence", "Key macros and pass_through must be standalone bindings");
          else { const name = command(item, itemPath); if (name) names.push(name); }
        });
        return { children: new Map(), binding: { kind: "commands", commands: names } };
      }
      if (!value || typeof value !== "object"
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        problem(path, "invalid_binding", "Use a command, command array, key table, or null"); return;
      }
      if (active.has(value)) { problem(path, "cyclic_keymap", "A keymap must not contain cycles"); return; }
      active.add(value);
      const node: TrieNode = { children: old?.children ?? new Map() };
      const seen = new Set<string>();
      for (const [key, entry] of Object.entries(value)) {
        let normalized: string;
        const entryPath = `${path}.${key}`;
        try { normalized = normalizeKey(key); }
        catch (error) { problem(entryPath, "invalid_key", error instanceof Error ? error.message : String(error)); continue; }
        if (seen.has(normalized)) { problem(entryPath, "duplicate_key", `Multiple keys normalize to ${JSON.stringify(normalized)}`); continue; }
        seen.add(normalized);
        const child = valueNode(entry, entryPath, node.children.get(normalized), depth + 1);
        if (child) node.children.set(normalized, child);
        if (bindings > this.maxBindings) break;
      }
      active.delete(value);
      return node;
    };
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      problem("keys", "invalid_keymaps", "Keymaps must be an object of mode tables");
    } else for (const [mode, value] of Object.entries(input)) {
      if (!modes.includes(mode as KeymapMode)) { problem(`keys.${mode}`, "invalid_mode", "Use normal, insert or select"); continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        problem(`keys.${mode}`, "invalid_mode_table", "A mode needs a table of bindings"); continue;
      }
      const compiled = valueNode(value, `keys.${mode}`, roots.get(mode as KeymapMode), 0);
      if (compiled) roots.set(mode as KeymapMode, compiled);
    }
    return { roots, diagnostics };
  }
}
