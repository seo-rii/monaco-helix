import type { Language, Node, Parser, Query, Tree } from "web-tree-sitter";
import { cursorOf, nextChar, previousChar, selectionBounds } from "./selection.js";
import type { HelixSelection } from "./selection.js";
import type { SyntaxDocument, SyntaxObject, SyntaxOperation, SyntaxProvider, SyntaxRequest, SyntaxResult } from "./syntax.js";

export interface TreeSitterLanguage {
  /** Self-hosted grammar URL, filesystem path (inline Node usage), or bytes. */
  wasm: string | Uint8Array;
  /** Standard Tree-sitter query with Helix-style *.inside/*.around/*.movement captures. */
  query?: string;
}

export interface TreeSitterOptions {
  /** Defaults to a module Worker. Inline mode is useful for Node or an existing host worker. */
  execution?: "worker" | "inline";
  workerFactory?: () => Worker;
  /** Directory containing the packaged runtime and three grammar WASM assets. */
  assetBaseUrl?: string;
  wasmUrl?: string;
  /** Additional or replacement language definitions; undefined entries disable a built-in. */
  languages?: Record<string, TreeSitterLanguage | undefined>;
  maxDocumentLength?: number;
  maxModels?: number;
  parseTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export type TreeSitterProvider = SyntaxProvider & { release(documentId: string): void; dispose(): void };

export class SyntaxBudgetError extends Error {
  constructor(readonly phase: "parse" | "query" | "selection", readonly limitMs: number, readonly elapsedMs?: number) {
    super(`Tree-sitter ${phase} exceeded its ${limitMs} ms time budget${elapsedMs === undefined ? "" : ` (${Math.ceil(elapsedMs)} ms elapsed)`}`);
    this.name = "SyntaxBudgetError";
  }
}

// Original queries for this package, using documented Helix capture names.
export const treeSitterQueries: Readonly<Record<string, string>> = {
  python: `
(function_definition body: (block) @function.inside) @function.around
(lambda body: (_) @function.inside) @function.around
(class_definition body: (block) @class.inside) @class.around
(parameters (_) @parameter.inside @parameter.around)
(lambda_parameters (_) @parameter.inside @parameter.around)
(argument_list (_) @parameter.inside @parameter.around)
(comment) @comment.inside @comment.around
((function_definition name: (identifier) @_test body: (block) @test.inside) @test.around
 (#match? @_test "^test_"))`,
  cpp: `
(function_definition body: (compound_statement) @function.inside) @function.around
(lambda_expression body: (compound_statement) @function.inside) @function.around
(class_specifier body: (field_declaration_list) @class.inside) @class.around
(struct_specifier body: (field_declaration_list) @class.inside) @class.around
(parameter_declaration) @parameter.inside @parameter.around
(optional_parameter_declaration) @parameter.inside @parameter.around
(variadic_parameter_declaration) @parameter.inside @parameter.around
(argument_list (_) @parameter.inside @parameter.around)
(comment) @comment.inside @comment.around`,
  typescript: `
(function_declaration body: (statement_block) @function.inside) @function.around
(function_expression body: (statement_block) @function.inside) @function.around
(generator_function body: (statement_block) @function.inside) @function.around
(generator_function_declaration body: (statement_block) @function.inside) @function.around
(arrow_function body: (_) @function.inside) @function.around
(method_definition body: (statement_block) @function.inside) @function.around
(class_declaration body: (class_body) @class.inside) @class.around
(interface_declaration body: (interface_body) @class.inside) @class.around
(type_alias_declaration value: (_) @class.inside) @class.around
(required_parameter) @parameter.inside @parameter.around
(optional_parameter) @parameter.inside @parameter.around
(arguments (_) @parameter.inside @parameter.around)
(comment) @comment.inside @comment.around
((call_expression function: (identifier) @_test arguments: (arguments) @test.inside) @test.around
 (#match? @_test "^(test|it|describe)$"))`,
};

interface Configuration {
  wasmUrl: string;
  languages: Record<string, TreeSitterLanguage | undefined>;
  maxDocumentLength: number;
  maxModels: number;
  parseTimeoutMs: number;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function configuration(options: TreeSitterOptions): Configuration {
  const base = options.assetBaseUrl
    ? new URL(options.assetBaseUrl.endsWith("/") ? options.assetBaseUrl : `${options.assetBaseUrl}/`, import.meta.url)
    : undefined;
  // Literal file URLs survive bundler asset rewriting; directory URLs can lose
  // their trailing slash and change the base of subsequent URL resolutions.
  const packaged = {
    runtime: new URL("./syntax-assets/tree-sitter.wasm", import.meta.url).href,
    python: new URL("./syntax-assets/tree-sitter-python.wasm", import.meta.url).href,
    cpp: new URL("./syntax-assets/tree-sitter-cpp.wasm", import.meta.url).href,
    typescript: new URL("./syntax-assets/tree-sitter-typescript.wasm", import.meta.url).href,
  };
  return {
    wasmUrl: options.wasmUrl ?? (base ? new URL("tree-sitter.wasm", base).href : packaged.runtime),
    languages: {
      python: { wasm: base ? new URL("tree-sitter-python.wasm", base).href : packaged.python, query: treeSitterQueries.python },
      cpp: { wasm: base ? new URL("tree-sitter-cpp.wasm", base).href : packaged.cpp, query: treeSitterQueries.cpp },
      typescript: { wasm: base ? new URL("tree-sitter-typescript.wasm", base).href : packaged.typescript, query: treeSitterQueries.typescript },
      ...options.languages,
    },
    maxDocumentLength: positive(options.maxDocumentLength, 2_000_000),
    maxModels: Math.max(1, Math.floor(positive(options.maxModels, 8))),
    parseTimeoutMs: positive(options.parseTimeoutMs, 500),
  };
}

type Runtime = typeof import("web-tree-sitter");
let runtime: Promise<Runtime> | undefined;
function loadRuntime(wasmUrl: string): Promise<Runtime> {
  if (!runtime) runtime = import("web-tree-sitter").then(async module => {
    await module.Parser.init({ locateFile: () => wasmUrl } as Parameters<typeof module.Parser.init>[0]);
    return module;
  }).catch(error => { runtime = undefined; throw error; });
  return runtime;
}

interface Session {
  parser: Parser;
  tree: Tree | null;
  text: string;
  languageId: string;
  version: number;
  /** Restores exact previous ranges after repeated parent expansion. */
  expansion: { after: string; before: HelixSelection[] }[];
}

function pointAt(text: string, offset: number): { row: number; column: number } {
  let row = 0;
  let start = 0;
  for (let p = text.indexOf("\n"); p >= 0 && p < offset; p = text.indexOf("\n", p + 1)) { row++; start = p + 1; }
  return { row, column: offset - start };
}

/** One enclosing edit safely represents any ordered group of Monaco changes. */
function updateTree(tree: Tree, before: string, after: string): void {
  let start = 0;
  while (start < before.length && start < after.length && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // Never split a surrogate pair at an edit boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(before[start] ?? "")) start--;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) { oldEnd--; newEnd--; }
  if (oldEnd < before.length && /[\uDC00-\uDFFF]/u.test(before[oldEnd] ?? "")) { oldEnd++; newEnd++; }
  tree.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
    startPosition: pointAt(before, start), oldEndPosition: pointAt(before, oldEnd), newEndPosition: pointAt(after, newEnd) });
}

function bounds(node: Node): HelixSelection { return { anchor: node.startIndex, head: node.endIndex }; }
function same(a: HelixSelection, b: HelixSelection): boolean {
  const [af, at] = selectionBounds(a); const [bf, bt] = selectionBounds(b);
  return af === bf && at === bt;
}
function oriented(range: HelixSelection, original: HelixSelection): HelixSelection {
  return original.anchor > original.head ? { anchor: range.head, head: range.anchor } : range;
}

/** Trim body delimiters, while preserving Python indentation-based suites. */
function inner(node: Node, object: SyntaxObject, text: string): HelixSelection {
  let start = node.startIndex;
  let end = node.endIndex;
  if (object === "comment") {
    const value = text.slice(start, end);
    if (value.startsWith("/*")) { start += 2; if (value.endsWith("*/")) end -= 2; }
    else if (value.startsWith("//")) start += 2;
    else if (value.startsWith("#")) start++;
  } else if (["compound_statement", "statement_block", "class_body", "field_declaration_list", "interface_body", "arguments"].includes(node.type)) {
    start++; end--;
  }
  return { anchor: Math.min(start, end), head: Math.max(start, end) };
}

function parameterAround(node: Node, text: string): HelixSelection {
  let start = node.startIndex; let end = node.endIndex;
  // Include the adjacent comma to make `mada` a useful argument removal.
  let p = end;
  while (p < text.length && /[ \t]/u.test(text[p])) p++;
  if (text[p] === ",") {
    end = p + 1;
    while (end < text.length && /[ \t]/u.test(text[end])) end++;
  } else {
    p = start;
    while (p > 0 && /[ \t]/u.test(text[p - 1])) p--;
    if (text[p - 1] === ",") start = p - 1;
  }
  return { anchor: start, head: end };
}

/** Actual WASM implementation, also useful inside an application's existing worker. */
export class TreeSitterEngine implements TreeSitterProvider {
  private readonly config: Configuration;
  private sessions = new Map<string, Session>();
  private languages = new Map<string, Promise<{ language: Language; query?: Query }>>();
  private requests = new Map<string, Set<{ released: boolean }>>();
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: TreeSitterOptions = {}) { this.config = configuration(options); }

  provide(request: SyntaxRequest): Promise<SyntaxResult | null> {
    const id = request.document.id;
    const token = { released: false };
    let pending = this.requests.get(id);
    if (!pending) { pending = new Set(); this.requests.set(id, pending); }
    pending.add(token);
    const result = this.tail.then(() => this.perform(request, token)).finally(() => {
      pending.delete(token);
      if (!pending.size) this.requests.delete(id);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async perform(request: SyntaxRequest, token: { released: boolean }): Promise<SyntaxResult | null> {
    const { document, signal } = request;
    const canceled = () => this.disposed || signal.aborted || token.released;
    if (canceled() || document.text.length > this.config.maxDocumentLength || !request.selections.length || request.selections.length > 10000) return null;
    const languageId = document.languageId === "c++" ? "cpp" : document.languageId;
    const definition = this.config.languages[languageId];
    if (!definition) return null;
    const api = await loadRuntime(this.config.wasmUrl);
    if (canceled()) return null;
    let loaded = this.languages.get(languageId);
    if (!loaded) {
      loaded = api.Language.load(definition.wasm).then(language => {
        const query = definition.query ? new api.Query(language, definition.query) : undefined;
        if (query && query.predicates.some(predicates => predicates.length)) {
          query.delete();
          throw new Error("Unsupported custom Tree-sitter query predicate");
        }
        if (this.disposed) { query?.delete(); throw new Error("Tree-sitter provider is disposed"); }
        return { language, query };
      }).catch(error => { this.languages.delete(languageId); throw error; });
      this.languages.set(languageId, loaded);
    }
    const { language, query } = await loaded;
    if (canceled()) return null;
    let session = this.sessions.get(document.id);
    if (session && session.languageId !== languageId) { this.destroySession(document.id); session = undefined; }
    if (!session) {
      const parser = new api.Parser();
      try { parser.setLanguage(language); } catch (error) { parser.delete(); throw error; }
      session = { parser, tree: null, text: "", languageId, version: -1, expansion: [] };
      this.sessions.set(document.id, session);
    }
    // Map insertion order is an LRU, so inactive editors have bounded parser/tree cost.
    this.sessions.delete(document.id); this.sessions.set(document.id, session);
    while (this.sessions.size > this.config.maxModels) this.destroySession(this.sessions.keys().next().value!);
    const deadline = performance.now() + this.config.parseTimeoutMs;
    if (!session.tree || session.text !== document.text) {
      if (session.tree) updateTree(session.tree, session.text, document.text);
      const old = session.tree;
      let tree: Tree | null;
      try { tree = session.parser.parse(document.text, old, { progressCallback: () => performance.now() > deadline || canceled() }); }
      catch (error) { this.destroySession(document.id); throw error; }
      old?.delete();
      session.tree = tree;
      session.text = document.text;
      session.expansion = [];
      if (!tree) {
        session.parser.reset();
        if (canceled()) return null;
        throw new SyntaxBudgetError("parse", this.config.parseTimeoutMs, performance.now() - deadline + this.config.parseTimeoutMs);
      }
    }
    session.version = document.version;
    if (canceled()) return null;
    if (performance.now() > deadline) throw new SyntaxBudgetError("parse", this.config.parseTimeoutMs, performance.now() - deadline + this.config.parseTimeoutMs);
    const ranges = this.select(session, document, request.selections, request.operation, query, deadline);
    return canceled() || !ranges ? null : { version: document.version, selections: ranges };
  }

  private select(session: Session, document: SyntaxDocument, selections: readonly HelixSelection[], operation: SyntaxOperation, query: Query | undefined, deadline: number): HelixSelection[] | null {
    const tree = session.tree!;
    const key = JSON.stringify(selections);
    if (operation.kind === "child") {
      const previous = session.expansion.at(-1);
      if (previous?.after === key) { session.expansion.pop(); return previous.before.map(range => ({ ...range })); }
    }
    let captures: { name: string; node: Node }[] | undefined;
    if ("object" in operation) {
      if (!query) return null;
      captures = query.captures(tree.rootNode, { matchLimit: 10000, timeoutMicros: Math.max(1, (deadline - performance.now()) * 1000), progressCallback: () => performance.now() > deadline });
      if (query.didExceedMatchLimit()) throw new Error("Tree-sitter query exceeded its 10000-match limit");
      if (performance.now() > deadline) throw new SyntaxBudgetError("query", this.config.parseTimeoutMs, performance.now() - deadline + this.config.parseTimeoutMs);
    }
    const result: HelixSelection[] = [];
    for (const original of selections) {
      if (performance.now() > deadline) throw new SyntaxBudgetError("selection", this.config.parseTimeoutMs, performance.now() - deadline + this.config.parseTimeoutMs);
      const [from, to] = selectionBounds(original);
      if (from < 0 || to > document.text.length) return null;
      let selected: HelixSelection | undefined;
      if ("object" in operation) {
        const object = operation.object === "type" ? "class" : operation.object;
        const count = Math.max(1, Math.min(10000, Math.floor(operation.count ?? 1)));
        const names = operation.kind === "object" ? [`${object}.${operation.around ? "around" : "inside"}`]
          : [`${object}.movement`, `${object}.around`, `${object}.inside`];
        let objects = captures!.filter(capture => capture.name === names.find(name => captures!.some(item => item.name === name)));
        if (operation.kind === "object") {
          // Inside captures often describe a function's body, outside the cursor on its name.
          // Match their surrounding capture from the same query pattern by containing object.
          const around = captures!.filter(capture => capture.name === `${object}.around` && capture.node.startIndex <= from && capture.node.endIndex >= to)
            .sort((a, b) => a.node.endIndex - a.node.startIndex - (b.node.endIndex - b.node.startIndex));
          const enclosing = around[Math.min(count - 1, around.length - 1)];
          if (enclosing) {
            if (operation.around) selected = object === "parameter" ? parameterAround(enclosing.node, document.text) : bounds(enclosing.node);
            else {
              const inside = objects.filter(capture => capture.node.startIndex >= enclosing.node.startIndex && capture.node.endIndex <= enclosing.node.endIndex)
                .sort((a, b) => b.node.endIndex - b.node.startIndex - (a.node.endIndex - a.node.startIndex))[0];
              if (inside) selected = inner(inside.node, operation.object, document.text);
            }
          }
        } else {
          const cursor = cursorOf(document.text, original);
          const unique = new Map<number, Node>();
          for (const capture of objects) unique.set(capture.node.startIndex, capture.node);
          const nodes = [...unique.values()].filter(node => operation.kind === "next" ? node.startIndex > cursor : node.startIndex < cursor)
            .sort((a, b) => operation.kind === "next" ? a.startIndex - b.startIndex : b.startIndex - a.startIndex);
          const node = nodes[Math.min(count - 1, nodes.length - 1)];
          if (node) selected = { anchor: node.startIndex, head: nextChar(document.text, node.startIndex) };
        }
      } else {
        let node = tree.rootNode.namedDescendantForIndex(from, Math.max(from, to - 1));
        if (node) {
          if (operation.kind === "parent") {
            while (node && node.startIndex >= from && node.endIndex <= to) node = node.parent;
            if (node) selected = bounds(node);
          } else if (operation.kind === "child") {
            const child = node.namedChildren.find(child => child && child.startIndex >= from && child.endIndex <= to && !same(bounds(child), original));
            if (child) selected = bounds(child);
          } else if (operation.kind === "previousSibling" || operation.kind === "nextSibling") {
            const sibling = operation.kind === "previousSibling" ? node.previousNamedSibling : node.nextNamedSibling;
            if (sibling) selected = bounds(sibling);
          } else if (operation.kind === "allChildren" || operation.kind === "allSiblings") {
            const children = operation.kind === "allChildren" ? node.namedChildren : node.parent?.namedChildren;
            if (children?.length) { result.push(...children.filter((child): child is Node => child !== null).map(child => oriented(bounds(child), original))); continue; }
          } else {
            node = node.parent;
            if (node) {
              const offset = operation.kind === "parentStart" ? node.startIndex : previousChar(document.text, node.endIndex);
              selected = { anchor: offset, head: nextChar(document.text, offset) };
            }
          }
        }
      }
      // Semantic selection is atomic across cursors: a queued `d` must not
      // delete an old range merely because one requested object was absent.
      if (operation.kind === "object" && !selected) return null;
      result.push(selected ? oriented(selected, original) : { ...original });
      if (result.length > 10000) return null;
    }
    if (operation.kind === "parent") {
      session.expansion.push({ after: JSON.stringify(result), before: selections.map(range => ({ ...range })) });
      if (session.expansion.length > 100) session.expansion.shift();
    } else if (operation.kind !== "child") session.expansion = [];
    return result;
  }

  private destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.tree?.delete(); session.parser.delete(); this.sessions.delete(id);
  }

  release(documentId: string): void {
    for (const request of this.requests.get(documentId) ?? []) request.released = true;
    this.destroySession(documentId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.sessions.keys()) this.destroySession(id);
    for (const loaded of this.languages.values()) void loaded.then(({ query }) => query?.delete(), () => undefined);
    this.languages.clear(); this.requests.clear();
  }
}

export interface SyntaxWorkerRequest {
  id: number;
  kind: "provide" | "release";
  config?: TreeSitterOptions;
  request?: Omit<SyntaxRequest, "signal">;
  documentId?: string;
}
export interface SyntaxWorkerResponse { id: number; result?: SyntaxResult | null; error?: string }

/** Lazy, optional Worker/WASM adapter; importing it does not load Tree-sitter. */
export function createTreeSitterProvider(options: TreeSitterOptions = {}): TreeSitterProvider {
  if (options.execution === "inline") return new TreeSitterEngine(options);
  const { workerFactory: _factory, execution: _execution, ...serializable } = options;
  // Complete absolute URLs are resolved once in the main adapter, before
  // bundlers establish a different import.meta.url for the Worker module.
  const workerConfiguration = { ...serializable, ...configuration(options) };
  let worker: Worker | undefined;
  let disposed = false;
  let nextId = 0;
  const waiting = new Map<number, { finish(result: SyntaxResult | null, error?: Error): void }>();
  const reset = (error?: Error) => {
    worker?.terminate(); worker = undefined;
    for (const value of [...waiting.values()]) value.finish(null, error);
    waiting.clear();
  };
  const getWorker = () => {
    if (!worker) {
      worker = options.workerFactory?.() ?? new Worker(new URL("./syntax-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<SyntaxWorkerResponse>) => {
        const response = event.data;
        waiting.get(response.id)?.finish(response.result ?? null, response.error ? new Error(response.error) : undefined);
      };
      worker.onerror = () => reset(new Error("Tree-sitter worker failed; check the worker and WASM asset URLs"));
      worker.onmessageerror = () => reset(new Error("Tree-sitter worker returned an unreadable message"));
    }
    return worker;
  };
  return {
    provide(request) {
      if (disposed || request.signal.aborted) return Promise.resolve(null);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => finish(null);
        const finish = (result: SyntaxResult | null, error?: Error) => {
          if (!waiting.delete(id)) return;
          if (timer) clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          if (error) reject(error); else resolve(result);
        };
        waiting.set(id, { finish });
        request.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reset(new Error("Tree-sitter request exceeded its time budget")), positive(options.requestTimeoutMs, 10000));
        try {
          const message: SyntaxWorkerRequest = { id, kind: "provide", config: workerConfiguration,
            request: { document: { ...request.document }, operation: { ...request.operation }, selections: request.selections.map(range => ({ ...range })) } };
          getWorker().postMessage(message);
        } catch (error) { finish(null, error instanceof Error ? error : new Error(String(error))); }
      });
    },
    release(documentId) { worker?.postMessage({ id: ++nextId, kind: "release", documentId } satisfies SyntaxWorkerRequest); },
    dispose() { if (!disposed) { disposed = true; reset(); } },
  };
}
