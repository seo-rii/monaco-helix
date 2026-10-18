import type { IDisposable } from "monaco-editor";
import type { Keymaps, KeymapUpdate } from "./keymap.js";
import type { SearchConfiguration } from "./search.js";
import type { MacroEngine } from "./macros.js";
import type { HostAdapter } from "./navigation.js";
import type { NavigationConfiguration } from "./host-controller.js";

export type HelixMode = "normal" | "insert" | "select";

export interface ClipboardAdapter {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface HelixOptions {
  /** Return false to let a host shortcut pass through untouched. */
  shouldHandleKey?: (event: KeyboardEvent, mode: HelixMode) => boolean;
  clipboard?: ClipboardAdapter;
  keymap?: Keymaps;
  /** Time before an incomplete Insert shortcut is flushed as ordinary input. */
  chordTimeoutMs?: number;
  search?: SearchConfiguration;
  host?: HostAdapter;
  navigation?: NavigationConfiguration;
  /** Application commands such as :write and :quit are delegated to the host. */
  onCommand?: (command: string) => void | Promise<void>;
  /** Receive clipboard failures, rejected host commands and unexpected errors. */
  onError?: (error: Error) => void;
  /** Called initially and whenever the mode changes, including model switches. */
  onModeChange?: (mode: HelixMode) => void;
}

export interface HelixBinding extends IDisposable {
  readonly macros: MacroEngine;
  getMode(): HelixMode;
  execute(command: string, args?: import("./commands.js").CommandArguments): Promise<void>;
  listCommands(): import("./commands.js").CommandInfo[];
  setKeymap(keymap: Keymaps): KeymapUpdate;
  feedKeys(keys: string): Promise<void>;
  cancel(): void;
  onDidChangeMode(listener: (mode: HelixMode) => void): IDisposable;
}

export interface KeyHint { key: string; command?: string; description?: string }
export interface PromptOptions {
  /** Internal pickers record a validated structured response themselves. */
  record?: boolean;
  onChange?: (value: string, signal: AbortSignal) => void | Promise<void>;
  onCancel?: () => void;
  history?: {
    record(value: string): void;
    previous(current?: string): string | undefined;
    next(): string | undefined;
    reset(): void;
  };
}

/** Internal UI bridge; the controller has no framework or workbench dependency. */
export interface ModalUI {
  mode: (mode: HelixMode, pending?: string) => void;
  notify: (message: string) => void;
  prompt: (label: string, submit: (value: string) => void | Promise<void>, initial?: string, config?: PromptOptions) => void;
  command: (value: string) => void | Promise<void>;
  hostCommand?: (command: string, args: import("./commands.js").CommandArguments, signal?: AbortSignal) => void | Promise<void>;
  recordJump?: () => void;
  hints?: (items: KeyHint[]) => void;
  promptActive?: () => boolean;
  submitPrompt?: (value: string, prefix?: string, cancel?: boolean) => Promise<void>;
  recordPrompt?: (value: string, prefix: string, cancel: boolean) => void;
  promptSettled?: (accepted: boolean, error?: unknown) => void | Promise<void>;
  promptOpened?: () => void;
  error: (error: unknown) => void;
}
