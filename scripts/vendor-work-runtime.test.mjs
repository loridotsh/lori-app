import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyVendor } from "./vendor-work-runtime.mjs";

test("runtime integrity rejects modified, additional, and missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lori-vendor-test-"));
  try {
    const files = {
      "work-core/Cargo.toml": "core",
      "work-core/src/lib.rs": "core source",
      "work-provider/Cargo.toml": "provider",
      "work-provider/src/lib.rs": "provider source",
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), text);
    }
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceRepository: "loridotsh/lori",
        sourceCommit: "a".repeat(40),
        sourceDirty: false,
        files: Object.fromEntries(
          Object.entries(files).map(([path, text]) => [
            path,
            createHash("sha256").update(text).digest("hex"),
          ]),
        ),
      }),
    );
    await verifyVendor(root);
    await writeFile(join(root, "work-core/src/lib.rs"), "tampered");
    await assert.rejects(verifyVendor(root), /integrity failed/);
    await writeFile(
      join(root, "work-core/src/lib.rs"),
      files["work-core/src/lib.rs"],
    );
    await writeFile(join(root, "work-core/src/unrecorded.rs"), "surprise");
    await assert.rejects(verifyVendor(root), /unrecorded files/);
    await rm(join(root, "work-core/src/unrecorded.rs"));
    await rm(join(root, "work-provider/Cargo.toml"));
    await assert.rejects(verifyVendor(root), /missing or unrecorded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
