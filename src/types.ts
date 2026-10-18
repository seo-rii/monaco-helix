import type { IDisposable } from "monaco-editor";

export type HelixMode = "normal" | "insert" | "select";

export interface HelixOptions {
  /** Application commands such as :write and :quit are delegated to the host. */
  onCommand?: (command: string) => void | Promise<void>;
  /** Receive clipboard failures, rejected host commands and unexpected errors. */
  onError?: (error: Error) => void;
  /** Called initially and whenever the mode changes, including model switches. */
  onModeChange?: (mode: HelixMode) => void;
}

export interface HelixBinding extends IDisposable {
  getMode(): HelixMode;
  onDidChangeMode(listener: (mode: HelixMode) => void): IDisposable;
}

/** Internal UI bridge; the controller has no framework or workbench dependency. */
export interface ModalUI {
  mode: (mode: HelixMode, pending?: string) => void;
  notify: (message: string) => void;
  prompt: (label: string, submit: (value: string) => void, initial?: string) => void;
  command: (value: string) => void;
  error: (error: unknown) => void;
}
