import { TreeSitterEngine } from "./tree-sitter.js";
import type { SyntaxWorkerRequest, SyntaxWorkerResponse } from "./tree-sitter.js";

// No DOM or Monaco imports: hosts can bundle this as a normal module Worker.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SyntaxWorkerRequest>) => void) | null;
  postMessage(message: SyntaxWorkerResponse): void;
};
let engine: TreeSitterEngine | undefined;
scope.onmessage = event => {
  const message = event.data;
  if (message.kind === "release") { if (message.documentId) engine?.release(message.documentId); return; }
  if (!message.request) return;
  engine ??= new TreeSitterEngine(message.config);
  const request = { ...message.request, signal: new AbortController().signal };
  void engine.provide(request).then(
    result => scope.postMessage({ id: message.id, result }),
    error => scope.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }),
  );
};
