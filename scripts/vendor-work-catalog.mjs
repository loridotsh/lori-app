#!/usr/bin/env node
// Compile the desktop's actual Rust catalog rather than maintaining a second list.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "apps/api/catalog/work-runtime.json");
const provenance = join(root, "apps/api/catalog/work-runtime.provenance.json");
const todoModule = join(root, "packages/contracts/src/todos.ts");
const hash = value => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
try {
  if (args.includes("--write")) {
    const index = args.indexOf("--source");
    if (index < 0 || !args[index + 1]) throw new Error("--write requires --source pointing to Lori");
    const source = resolve(args[index + 1]);
    const directory = join(source, "src-tauri/src/work/extensions");
    const original = await readFile(join(directory, "catalog.rs"), "utf8");
    const staging = await mkdtemp(join(tmpdir(), "lori-work-catalog-"));
    try {
      await mkdir(join(staging, "src"));
      await writeFile(join(staging, "Cargo.toml"), '[package]\nname="lori-work-catalog-export"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nserde={version="1",features=["derive"]}\nserde_json="1"\n');
      const skillDirectory = JSON.stringify(join(directory, "skills/").replaceAll("\\", "/"));
      await writeFile(join(staging, "src/catalog.rs"), original.replace(/^\/\/!/gm, "//").replaceAll('concat!("skills/",', `concat!(${skillDirectory},`));
      await writeFile(join(staging, "src/main.rs"), `#![allow(dead_code)]
mod work {pub mod conversations {pub mod types {pub fn error(_code:&str,message:&str)->String{message.into()}}}}
mod types {pub type Error=String;}
mod catalog;
fn main(){
 let skills:Vec<_>=catalog::SKILLS.iter().map(|skill|{
   let mut value=serde_json::to_value(skill).unwrap();
   let references:std::collections::BTreeMap<_,_>=catalog::references(skill.id).iter().filter(|name|**name!="SKILL.md").map(|name|(*name,catalog::reference(skill.id,name).unwrap())).collect();
   value["references"]=serde_json::to_value(references).unwrap();value
 }).collect();
 println!("{}",serde_json::to_string_pretty(&serde_json::json!({"schemaVersion":1,"plugins":catalog::PLUGINS,"skills":skills})).unwrap());
}
`);
      const bytes = execFileSync("cargo", ["run", "--quiet", "--offline", "--manifest-path", join(staging, "Cargo.toml"), "--target-dir", join(root, ".local/catalog-build")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const value = JSON.parse(bytes);
      if (!Array.isArray(value.skills) || !Array.isArray(value.plugins)) throw new Error("Catalog export failed");
      value.harness = { version: 4, instructions: await readFile(join(source, "src-tauri/crates/work-core/src/instructions.md"), "utf8"), todoWriteParameters: JSON.parse(await readFile(join(source, "src-tauri/crates/work-core/src/todos.schema.json"), "utf8")) };
      const todoSource = "// Generated from Lori src/work/tasks/model.ts. Regenerate with vendor-work-catalog.mjs.\n" + await readFile(join(source, "src/work/tasks/model.ts"), "utf8");
      const serialized = JSON.stringify(value, null, 2) + "\n";
      const inputs = ["src-tauri/src/work/extensions/catalog.rs", "src-tauri/crates/work-core/src/instructions.md", "src-tauri/crates/work-core/src/todos.schema.json", "src/work/tasks/model.ts"];
      for (const skill of value.skills) {
        inputs.push(`src-tauri/src/work/extensions/skills/${skill.id}/SKILL.md`);
        for (const reference of Object.keys(skill.references)) inputs.push(`src-tauri/src/work/extensions/skills/${skill.id}/${reference}`);
      }
      const sourceFiles = Object.fromEntries(await Promise.all(inputs.sort().map(async path => [path, hash(await readFile(join(source, path)))])));
      const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["-C", source, "status", "--porcelain", "--", ...inputs], { encoding: "utf8" }).trim().length > 0;
      await writeFile(output, serialized);
      await writeFile(todoModule, todoSource);
      await writeFile(provenance, JSON.stringify({ schemaVersion: 1, sourceRepository: "loridotsh/lori", sourceCommit: commit, sourceDirty: dirty, sha256: hash(serialized), todoSha256: hash(todoSource), sourceFiles }, null, 2) + "\n");
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const metadata = JSON.parse(await readFile(provenance, "utf8"));
  const bytes = await readFile(output);
  if (metadata.schemaVersion !== 1 || metadata.sourceRepository !== "loridotsh/lori" || !/^[a-f0-9]{40}$/.test(metadata.sourceCommit) || hash(bytes) !== metadata.sha256) throw new Error("Work catalog integrity failed");
  if (typeof metadata.todoSha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.todoSha256) || hash(await readFile(todoModule)) !== metadata.todoSha256) throw new Error("Work todo contract integrity failed");
  if (args.includes("--release") && metadata.sourceDirty) throw new Error("Release requires a Work catalog generated from committed source");
  if (args.includes("--source") && !args.includes("--write")) {
    const source = resolve(args[args.indexOf("--source") + 1]);
    for (const [path, expected] of Object.entries(metadata.sourceFiles)) if (hash(await readFile(join(source, path))) !== expected) throw new Error(`Work catalog differs from source: ${path}`);
  }
  console.log("Bundled Work catalog integrity verified");
} catch (error) {
  console.error(error.stderr?.toString()?.slice(-4000) ?? error.message ?? "Work catalog export failed");
  process.exitCode = 1;
}
