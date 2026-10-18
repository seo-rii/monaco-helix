import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { initHelixMode } from '../../src/index';
import '../../src/styles.css';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const editor = monaco.editor.create(document.getElementById('editor')!, {
  value: 'alpha beta\nsecond line\nthird',
  language: 'plaintext',
  theme: 'vs-dark',
  automaticLayout: false,
  minimap: { enabled: false },
  editContext: false,
  quickSuggestions: false,
  wordBasedSuggestions: 'off',
  suggestOnTriggerCharacters: false,
  autoClosingBrackets: 'never',
  autoClosingQuotes: 'never',
  accessibilitySupport: 'off',
  cursorStyle: 'line',
  cursorBlinking: 'blink',
  domReadOnly: false,
});
const testState = {
  modeChanges: [] as string[],
  commands: [] as string[],
  errors: [] as string[],
};
const helix = initHelixMode(editor, document.getElementById('status')!, {
  onModeChange(mode) { testState.modeChanges.push(mode); },
  onCommand(command) { testState.commands.push(command); },
  onError(error) { testState.errors.push(error.message); },
});

Object.assign(window, { editor, monaco, helix, initHelixMode, testState });
editor.focus();

declare global {
  interface Window {
    editor: typeof editor;
    monaco: typeof monaco;
    helix: typeof helix;
    initHelixMode: typeof initHelixMode;
    testState: typeof testState;
    resolveClipboard?: (value: string) => void;
    clipboardReads?: number;
  }
}
