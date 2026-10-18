import type { HelixSelection } from "./selection.js";

/** All public syntax coordinates are half-open UTF-16 offsets. */
export interface SyntaxDocument {
  id: string;
  version: number;
  languageId: string;
  text: string;
}

export type SyntaxObject = "function" | "type" | "parameter" | "comment" | "test";

export type SyntaxOperation =
  | { kind: "object"; object: SyntaxObject; around: boolean; count?: number }
  | { kind: "next" | "previous"; object: SyntaxObject; count?: number }
  | { kind: "parent" | "child" | "previousSibling" | "nextSibling" | "allSiblings" | "allChildren" | "parentStart" | "parentEnd" };

export interface SyntaxRequest {
  document: SyntaxDocument;
  selections: readonly HelixSelection[];
  operation: SyntaxOperation;
  signal: AbortSignal;
}

export interface SyntaxResult {
  version: number;
  selections: HelixSelection[];
}

/** Providers can be shared. A binding releases its models but never owns the provider. */
export interface SyntaxProvider {
  provide(request: SyntaxRequest): Promise<SyntaxResult | null>;
  release?(documentId: string): void;
  dispose?(): void;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Coordinate safety is enforced even for third-party providers. */
function validate(text: string, ranges: readonly HelixSelection[]): HelixSelection[] | null {
  if (!ranges.length || ranges.length > 10000) return null;
  const segments = segmenter.segment(text);
  const startOf = (value: number) => value === text.length ? value : segments.containing(value)?.index ?? value;
  const endOf = (value: number) => {
    if (value === text.length || startOf(value) === value) return value;
    const part = segments.containing(value)!;
    return part.index + part.segment.length;
  };
  const result: HelixSelection[] = [];
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.anchor) || !Number.isSafeInteger(range.head)
      || range.anchor < 0 || range.head < 0 || range.anchor > text.length || range.head > text.length) return null;
    const forward = range.anchor <= range.head;
    const from = startOf(Math.min(range.anchor, range.head));
    const to = endOf(Math.max(range.anchor, range.head));
    result.push(forward ? { anchor: from, head: to } : { anchor: to, head: from });
  }
  return result;
}

/** One pending selection operation per binding; stale responses are never applied. */
export class SyntaxCoordinator {
  private pending: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private documents = new Set<string>();

  constructor(private readonly provider: SyntaxProvider) {}

  async query(
    document: SyntaxDocument,
    selections: readonly HelixSelection[],
    operation: SyntaxOperation,
    signal?: AbortSignal,
  ): Promise<HelixSelection[] | null> {
    this.cancel();
    if (this.disposed || signal?.aborted) return null;
    const controller = new AbortController();
    this.pending = controller;
    const generation = this.generation;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    this.documents.add(document.id);
    // Snapshot mutable host inputs before crossing an asynchronous boundary.
    const snapshot = { ...document };
    const ranges = selections.map(range => ({ ...range }));
    let settleCancellation: (() => void) | undefined;
    const canceled = new Promise<null>(resolve => {
      settleCancellation = () => resolve(null);
      controller.signal.addEventListener("abort", settleCancellation, { once: true });
    });
    try {
      const result = await Promise.race([
        this.provider.provide({ document: snapshot, selections: ranges, operation: { ...operation }, signal: controller.signal }),
        canceled,
      ]);
      if (this.disposed || controller.signal.aborted || generation !== this.generation || !result || result.version !== snapshot.version) return null;
      return validate(snapshot.text, result.selections);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return null;
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (settleCancellation) controller.signal.removeEventListener("abort", settleCancellation);
      if (this.pending === controller) this.pending = undefined;
    }
  }

  cancel(): void {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
  }

  release(documentId: string): void {
    this.cancel();
    if (this.documents.delete(documentId)) this.provider.release?.(documentId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    for (const id of this.documents) this.provider.release?.(id);
    this.documents.clear();
  }
}
