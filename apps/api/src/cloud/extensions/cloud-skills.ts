import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Catalog } from "./service.js";

/**
 * Cloud Work runs documents in a private sandbox with a design kit and no
 * desktop "job" workflow. The vendored desktop skills (hash-pinned, never
 * edited) describe the desktop flow, so Cloud serves its own versions of the
 * document skills from `catalog/cloud-skills/<id>/`. Only skills that exist in
 * the vendored catalog are replaced; everything else is left untouched.
 *
 * Layout: `<id>/SKILL.md`, `<id>/references/*.md`, and `shared/*.md` which is
 * offered to every overlaid skill as `references/<file>` (a skill's own file of
 * the same name wins).
 */
export const CLOUD_SKILLS_VERSION_SUFFIX = "-cloud";

/**
 * The file a `load_skill` reference means. Models often shorten
 * `references/creation.md` to `creation.md` or `creation`, so an unambiguous short
 * name resolves instead of costing a round. Unknown names return undefined.
 */
export function skillReference(references: Record<string, string>, value: string): string | undefined {
  const name = value.replace(/^\.?\//, "");
  if (name === "SKILL.md" || Object.hasOwn(references, name)) return name;
  const file = name.split("/").at(-1)!.replace(/\.md$/, "");
  return Object.hasOwn(references, `references/${file}.md`) ? `references/${file}.md` : undefined;
}

const directory = new URL("../../../catalog/cloud-skills/", import.meta.url);

function readMarkdown(folder: string): Record<string, string> {
  if (!existsSync(folder)) return {};
  const files: Record<string, string> = {};
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md"))
      files[entry.name] = readFileSync(join(folder, entry.name), "utf8");
  }
  return files;
}

export function parseSkillFile(source: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { body: source };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]!] = pair[2]!.trim();
  }
  return {
    name: meta.name,
    description: meta.description,
    // Keep the front matter in the served text, as the vendored skills do.
    body: source,
  };
}

export function overlayCloudSkills(
  catalog: Catalog,
  root: string = fileURLToPath(directory),
): Catalog {
  if (!existsSync(root)) return catalog;
  const shared = readMarkdown(join(root, "shared"));
  const skills = catalog.skills.map((base) => {
    const skillDirectory = join(root, base.id);
    const skillFile = join(skillDirectory, "SKILL.md");
    if (!existsSync(skillFile)) return base;
    const parsed = parseSkillFile(readFileSync(skillFile, "utf8"));
    if (parsed.name && parsed.name !== base.id)
      throw new Error(
        `Cloud skill ${base.id} declares the name ${parsed.name}`,
      );
    const references: Record<string, string> = {};
    for (const [file, text] of Object.entries(shared))
      references[`references/${file}`] = text;
    for (const [file, text] of Object.entries(
      readMarkdown(join(skillDirectory, "references")),
    ))
      references[`references/${file}`] = text;
    return {
      ...base,
      description: parsed.description || base.description,
      version: `${base.version.replace(/-cloud$/, "")}${CLOUD_SKILLS_VERSION_SUFFIX}`,
      instructions: parsed.body,
      references,
    };
  });
  return { ...catalog, skills };
}
