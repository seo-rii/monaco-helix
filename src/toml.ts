/** Optional parser entrypoint: the core keymap engine has no TOML dependency. */
import { parse } from "smol-toml";
import { KeymapEngine, type KeymapDiagnostic, type KeymapOptions, type Keymaps } from "./keymap.js";

export interface TomlKeymaps {
  ok: boolean;
  keymap: Keymaps;
  diagnostics: KeymapDiagnostic[];
}

/** Import only Helix [keys.*] tables from a config.toml string. No file or network IO. */
export function importKeymapToml(source: string, options: KeymapOptions = {}): TomlKeymaps {
  const diagnostics: KeymapDiagnostic[] = [];
  let document: Record<string, unknown>;
  try { document = parse(source, { unsafeKeyBehaviour: "throw" }); }
  catch (error) {
    const details = error as { message?: string; line?: number; column?: number };
    return {
      ok: false, keymap: {}, diagnostics: [{
        severity: "error", code: "invalid_toml", path: "config",
        message: details.message ?? String(error),
        ...(typeof details.line === "number" ? { line: details.line } : {}),
        ...(typeof details.column === "number" ? { column: details.column } : {}),
      }],
    };
  }
  for (const section of Object.keys(document)) {
    if (section !== "keys") diagnostics.push({
      severity: "warning", code: "ignored_section", path: section,
      message: `Only [keys.normal], [keys.insert] and [keys.select] are imported; ${section} is ignored`,
    });
  }
  const candidate = document.keys ?? {};
  // The engine validates command names, types, aliases, cycles and limits using
  // the same rules as JavaScript configuration. A failed import returns no map.
  const engine = new KeymapEngine({}, options);
  const checked = engine.replace(candidate as Keymaps);
  diagnostics.push(...checked.diagnostics);
  return { ok: checked.ok, keymap: checked.ok ? candidate as Keymaps : {}, diagnostics };
}

/** Parse and atomically apply overrides to a running pure keymap engine. */
export function applyKeymapToml(engine: KeymapEngine, source: string, options: KeymapOptions = {}): TomlKeymaps {
  const imported = importKeymapToml(source, options);
  if (!imported.ok) return imported;
  const applied = engine.replace(imported.keymap);
  return {
    ok: applied.ok,
    keymap: applied.ok ? imported.keymap : {},
    diagnostics: [...imported.diagnostics, ...applied.diagnostics],
  };
}
