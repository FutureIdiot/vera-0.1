import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const distRoot = new URL("../frontend/dist/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL(".vite/manifest.json", distRoot), "utf8"));
const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
if (!entry) throw new Error("Vite manifest has no entry chunk");

function collectStatic(chunk, files = new Set()) {
  if (!chunk || files.has(chunk.file)) return files;
  files.add(chunk.file);
  for (const css of chunk.css ?? []) files.add(css);
  for (const imported of chunk.imports ?? []) collectStatic(manifest[imported], files);
  return files;
}

function findChunk(sourceSuffix) {
  const match = Object.entries(manifest).find(([source, chunk]) => source.endsWith(sourceSuffix) || chunk.name === sourceSuffix);
  return match?.[1] ?? null;
}

async function measure(files) {
  const rows = [];
  let totalGzipBytes = 0;
  for (const file of [...files].sort()) {
    const body = await readFile(new URL(file, distRoot));
    const gzipBytes = gzipSync(body).length;
    totalGzipBytes += gzipBytes;
    rows.push({ file, bytes: body.length, gzipBytes });
  }
  return { totalGzipBytes, files: rows };
}

const shellFiles = collectStatic(entry);
const defaultChatFiles = new Set(shellFiles);
collectStatic(findChunk("platform-web"), defaultChatFiles);
collectStatic(findChunk("src/views/space-view.js"), defaultChatFiles);

const shell = await measure(shellFiles);
const defaultChat = await measure(defaultChatFiles);
const routeChunks = Object.entries(manifest)
  .filter(([, chunk]) => chunk.isDynamicEntry)
  .map(([source, chunk]) => ({ source, file: chunk.file }));
const requiredLazyRoutes = [
  "src/views/settings-index-view.js",
  "src/views/account-list-view.js",
  "src/views/account-detail-view.js",
  "src/views/agent-detail-view.js",
  "src/views/capability-directory-view.js",
  "src/views/agent-data-view.js",
  "src/views/agent-memory-config-view.js",
  "src/views/agent-memory-library-view.js",
  "src/views/system-settings-view.js",
  "src/views/appearance-view.js",
  "src/views/path-settings-view.js",
  "src/views/control-center-view.js",
];
const missingLazyRoutes = requiredLazyRoutes.filter((suffix) => !findChunk(suffix)?.isDynamicEntry);
const spaceViewSource = await readFile(new URL("../frontend/src/views/space-view.js", import.meta.url), "utf8");
const timelineLimit = Number(spaceViewSource.match(/TIMELINE_DOM_LIMIT\s*=\s*(\d+)/)?.[1]);
const budgetGzipBytes = 200 * 1024;
const report = {
  generatedAt: new Date().toISOString(),
  entry: entry.file,
  budgetGzipBytes,
  shell,
  defaultChat,
  routeChunks,
  requiredLazyRoutes,
  timelineDomLimit: timelineLimit,
};

await writeFile(new URL("bundle-report.json", distRoot), `${JSON.stringify(report, null, 2)}\n`);
for (const row of defaultChat.files) console.log(`${row.file}: ${row.gzipBytes} bytes gzip`);
console.log(`shell: ${shell.totalGzipBytes} bytes gzip`);
console.log(`default chat: ${defaultChat.totalGzipBytes} / ${budgetGzipBytes} bytes gzip`);
console.log(`dynamic routes: ${routeChunks.length}; timeline DOM limit: ${timelineLimit}`);

if (defaultChat.totalGzipBytes > budgetGzipBytes) process.exitCode = 1;
if (missingLazyRoutes.length) {
  console.error(`routes missing dynamic chunks: ${missingLazyRoutes.join(", ")}`);
  process.exitCode = 1;
}
if (timelineLimit !== 200) {
  console.error(`timeline DOM limit must remain 200, received ${timelineLimit || "unknown"}`);
  process.exitCode = 1;
}
