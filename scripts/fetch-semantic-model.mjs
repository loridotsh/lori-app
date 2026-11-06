#!/usr/bin/env node
// Places the pinned semantic memory model next to the API, verified by size and SHA-256.
// Offline builds: pass --from <directory> holding the same files; nothing is downloaded.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "apps/api/semantic/manifest.json"), "utf8"));
const target = join(root, "apps/api/semantic/model", manifest.id);
const fromIndex = process.argv.indexOf("--from");
const from = fromIndex > 0 ? resolve(process.argv[fromIndex + 1] ?? "") : null;
const mirror = process.env.LORI_SEMANTIC_MODEL_URL?.startsWith("https://") ? process.env.LORI_SEMANTIC_MODEL_URL.replace(/\/?$/, "/") : manifest.source;

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function valid(path, file) {
  return existsSync(path) && statSync(path).size === file.size && (await digest(path)) === file.sha256;
}

mkdirSync(target, { recursive: true });
for (const [name, file] of Object.entries(manifest.files)) {
  const destination = join(target, name.split("/").at(-1));
  if (await valid(destination, file)) continue;
  const partial = `${destination}.partial`;
  rmSync(partial, { force: true });
  if (from) {
    const source = join(from, name.split("/").at(-1));
    if (!(await valid(source, file))) throw new Error(`${name}: offline copy is missing or does not match the pinned hash`);
    await pipeline(createReadStream(source), createWriteStream(partial));
  } else {
    const response = await fetch(`${mirror}${name}`, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`${name}: download failed (${response.status})`);
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; done(size > file.size ? new Error(`${name}: larger than pinned size`) : null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial));
  }
  if (!(await valid(partial, file))) { rmSync(partial, { force: true }); throw new Error(`${name}: hash mismatch`); }
  renameSync(partial, destination);
}
console.log(`Semantic memory model ready: ${target}`);
