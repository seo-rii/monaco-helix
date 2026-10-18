import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const output = new URL("../dist/syntax-assets/", import.meta.url);
await mkdir(output, { recursive: true });
const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
const grammarRoot = dirname(require.resolve("tree-sitter-wasms/package.json"));
const runtimePackage = JSON.parse(await readFile(join(dirname(runtime), "package.json"), "utf8"));
const grammarPackage = JSON.parse(await readFile(join(grammarRoot, "package.json"), "utf8"));
// Loading incompatible WASM ABIs/dynamic-link formats must fail the build,
// rather than silently shipping a different untested runtime/grammar pair.
if (runtimePackage.version !== "0.25.10" || grammarPackage.version !== "0.1.13") {
  throw new Error("Syntax assets require verified web-tree-sitter 0.25.10 and tree-sitter-wasms 0.1.13");
}
const sources = {
  "tree-sitter.wasm": runtime,
  ...Object.fromEntries(["python", "cpp", "typescript"].map(language => [`tree-sitter-${language}.wasm`, join(grammarRoot, "out", `tree-sitter-${language}.wasm`)])),
};
const assets = {};
for (const [name, source] of Object.entries(sources)) {
  await copyFile(source, new URL(name, output));
  const contents = await readFile(source);
  assets[name] = { bytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") };
}
const runtimeLicense = await readFile(join(dirname(runtime), "LICENSE"), "utf8");
const prebuiltLicense = await readFile(join(grammarRoot, "LICENSE"), "utf8");
// Verified against the official upstream LICENSE files at the declared source
// versions. All three have the same body below; retain their own notices rather
// than substituting the prebuilt package's Unlicense or the runtime copyright.
// These tags document notice provenance, not exact binary source commits.
const mitTerms = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const notices = [
  { name: "tree-sitter-python", tag: "v0.21.0", copyright: "Copyright (c) 2016 Max Brunsfeld" },
  { name: "tree-sitter-cpp", tag: "v0.20.4", copyright: "Copyright (c) 2014 Max Brunsfeld" },
  { name: "tree-sitter-typescript", tag: "v0.20.5", copyright: "Copyright (c) 2017 GitHub" },
].map(notice => ({ ...notice, source: `https://github.com/tree-sitter/${notice.name}/blob/${notice.tag}/LICENSE` }));
const grammarLicenses = notices.map(({ name, source, copyright }) => `${name}\n${source}\nThe MIT License (MIT)\n\n${copyright}\n\n${mitTerms}`).join("\n\n");
await writeFile(new URL("LICENSES.txt", output), `web-tree-sitter 0.25.10\nhttps://github.com/tree-sitter/tree-sitter\n${runtimeLicense}\n\ntree-sitter-wasms 0.1.13\n${grammarPackage.repository.url ?? grammarPackage.repository}\n${prebuiltLicense}\n\n${grammarLicenses}`);
await writeFile(new URL("manifest.json", output), `${JSON.stringify({
  runtime: { package: "web-tree-sitter", version: runtimePackage.version },
  grammars: { package: "tree-sitter-wasms", version: grammarPackage.version,
    declaredGrammarSources: Object.fromEntries(["python", "cpp", "typescript"].map(language => [`tree-sitter-${language}`, grammarPackage.devDependencies[`tree-sitter-${language}`]])) },
  queryRevision: 1,
  grammarLicenseNotices: notices,
  // The prebuilt package declares source ranges, not exact grammar commits.
  // Pin its tarball in package-lock and identify the actual binaries by hash.
  assets,
}, null, 2)}\n`);
