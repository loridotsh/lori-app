#!/usr/bin/env node
// Source snapshots are generated from Lori, never independently edited here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultVendor = join(repository, "apps/worker/vendor");
const packages = ["work-provider", "work-core"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function filesIn(directory, prefix = "") {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Runtime package contains a symlink: ${relative}`);
    if (entry.isDirectory())
      result.push(...(await filesIn(join(directory, entry.name), relative)));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unsupported runtime package entry: ${relative}`);
  }
  return result;
}

export async function verifyVendor(destination = defaultVendor) {
  const manifest = JSON.parse(
    await readFile(join(destination, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.sourceRepository !== "loridotsh/lori" ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    typeof manifest.sourceDirty !== "boolean" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error("Invalid Work runtime provenance manifest");
  const listed = Object.keys(manifest.files).sort();
  if (
    listed.length < 4 ||
    listed.some(
      (path) =>
        !/^(work-(?:provider|core)\/(?:Cargo\.toml|(?:src|tests)\/[a-zA-Z0-9_./-]+)|work-runtime\/(?:worker\.py|document_helpers\.py|requirements\.lock|requirements\.in)|LICENSE)$/.test(
          path,
        ) || path.split("/").includes(".."),
    )
  )
    throw new Error("Invalid runtime package path");
  const actual = (await filesIn(destination))
    .filter((path) => path !== "manifest.json")
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(listed))
    throw new Error("Runtime snapshot has missing or unrecorded files");
  for (const path of listed) {
    if (hash(await readFile(join(destination, path))) !== manifest.files[path])
      throw new Error(`Work runtime integrity failed: ${path}`);
  }
  return manifest;
}

export async function vendorRuntime(source, destination = defaultVendor) {
  const root = resolve(source);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync(
      "git",
      [
        "-C",
        root,
        "status",
        "--porcelain",
        "--",
        ...packages.map((p) => `src-tauri/crates/${p}`),
        "runtime/work/worker.py", "runtime/work/document_helpers.py", "runtime/work/requirements.lock", "runtime/work/requirements.in", "LICENSE",
      ],
      { encoding: "utf8" },
    ).trim().length > 0;
  const entries = new Map();
  for (const name of packages) {
    const directory = join(root, "src-tauri/crates", name);
    for (const relative of await filesIn(directory)) {
      if (
        relative !== "Cargo.toml" &&
        !relative.startsWith("src/") &&
        !relative.startsWith("tests/")
      )
        continue;
      entries.set(
        `${name}/${relative}`,
        await readFile(join(directory, relative)),
      );
    }
  }
  const license = join(root, "LICENSE");
  for (const name of ["worker.py", "document_helpers.py", "requirements.lock", "requirements.in"]) {
    entries.set(`work-runtime/${name}`, await readFile(join(root, "runtime/work", name)));
  }
  if (!(await lstat(license)).isFile())
    throw new Error("Missing source license");
  entries.set("LICENSE", await readFile(license));
  const manifest = {
    schemaVersion: 1,
    sourceRepository: "loridotsh/lori",
    sourceCommit: commit,
    sourceDirty: dirty,
    files: Object.fromEntries(
      [...entries]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => [path, hash(bytes)]),
    ),
  };
  const staging = `${destination}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  try {
    for (const [path, bytes] of entries) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), bytes);
    }
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await verifyVendor(staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    const sourceIndex = args.indexOf("--source");
    const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
    if (args.includes("--write")) {
      if (!source)
        throw new Error(
          "--write requires --source pointing to the Lori checkout",
        );
      const manifest = await vendorRuntime(source);
      console.log(
        `Packaged Work runtime from ${manifest.sourceCommit}${manifest.sourceDirty ? " (uncommitted source; not release qualified)" : ""}`,
      );
    } else {
      const manifest = await verifyVendor();
      if (args.includes("--release") && manifest.sourceDirty)
        throw new Error(
          "Release requires a snapshot from committed Work runtime source",
        );
      if (source) {
        for (const [path, expected] of Object.entries(manifest.files)) {
          const original =
            path === "LICENSE"
              ? join(source, path)
              : path.startsWith("work-runtime/") ? join(source, "runtime/work", path.slice("work-runtime/".length)) : join(source, "src-tauri/crates", path);
          if (hash(await readFile(original)) !== expected)
            throw new Error(`Runtime snapshot differs from source: ${path}`);
        }
      }
      console.log("Work runtime snapshot integrity verified");
    }
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Work runtime verification failed",
    );
    process.exitCode = 1;
  }
}
