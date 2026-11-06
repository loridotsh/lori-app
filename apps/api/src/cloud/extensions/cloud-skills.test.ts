import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { overlayCloudSkills, parseSkillFile, skillReference } from "./cloud-skills.js";
import type { Catalog } from "./service.js";

describe("skillReference", () => {
  const references = { "references/creation.md": "guide" };
  it.each(["references/creation.md", "./references/creation.md", "creation.md", "creation", "docs/creation.md"])(
    "resolves %s", (name) => {
      expect(skillReference(references, name)).toBe("references/creation.md");
    });
  it("keeps the main guide and refuses what does not exist", () => {
    expect(skillReference(references, "SKILL.md")).toBe("SKILL.md");
    expect(skillReference(references, "research")).toBeUndefined();
    expect(skillReference(references, "__proto__")).toBeUndefined();
  });
});

const base = JSON.parse(
  readFileSync(
    new URL("../../../catalog/work-runtime.json", import.meta.url),
    "utf8",
  ),
) as Catalog;
const overlaid = overlayCloudSkills(base);
const DOCUMENT_SKILLS = ["documents", "spreadsheets", "presentations", "pdfs"];
const kitRoot = new URL(
  "../../../../worker/native/lori_design/",
  import.meta.url,
);

describe("cloud skills overlay", () => {
  it("replaces only the document skills and keeps ids, capabilities and plugins", () => {
    expect(overlaid.plugins).toEqual(base.plugins);
    expect(overlaid.skills.map((s) => s.id)).toEqual(
      base.skills.map((s) => s.id),
    );
    for (const skill of overlaid.skills) {
      const original = base.skills.find((s) => s.id === skill.id)!;
      expect(skill.capability).toBe(original.capability);
      if (DOCUMENT_SKILLS.includes(skill.id)) {
        expect(skill.version).toMatch(/-cloud$/);
        expect(skill.instructions).not.toBe(original.instructions);
      } else {
        expect(skill).toEqual(original);
      }
    }
  });

  it("never mentions the desktop job workflow", () => {
    for (const id of DOCUMENT_SKILLS) {
      const skill = overlaid.skills.find((s) => s.id === id)!;
      const text = [skill.instructions, ...Object.values(skill.references)];
      for (const body of text) {
        // Instructions may say these do not exist; they must never tell the model to call them.
        expect(body).not.toMatch(/\b(begin_document_job|publish_document)\s*\(/);
        expect(body).not.toMatch(/call\s+`?(begin_document_job|publish_document)/i);
      }
    }
  });

  it("serves every reference its guide points at", () => {
    for (const id of DOCUMENT_SKILLS) {
      const skill = overlaid.skills.find((s) => s.id === id)!;
      const names = [...skill.instructions.matchAll(/`(references\/[\w.-]+\.md)`/g)].map(
        (m) => m[1]!,
      );
      expect(names.length).toBeGreaterThan(0);
      for (const name of new Set(names))
        expect(Object.keys(skill.references), `${id} ${name}`).toContain(name);
      expect(Object.keys(skill.references)).toEqual(
        expect.arrayContaining([
          "references/creation.md",
          "references/editing.md",
          "references/design-principles.md",
          "references/verification.md",
        ]),
      );
    }
  });

  it("only documents kit functions that exist", () => {
    const sources: Record<string, string> = {};
    for (const file of readdirSync(kitRoot))
      if (file.endsWith(".py"))
        sources[file] = readFileSync(new URL(file, kitRoot), "utf8");
    const modules: Record<string, string> = {
      documents: "docx_kit.py",
      spreadsheets: "xlsx_kit.py",
      presentations: "pptx_kit.py",
      pdfs: "pdf_kit.py",
    };
    for (const id of DOCUMENT_SKILLS) {
      const skill = overlaid.skills.find((s) => s.id === id)!;
      const text = [skill.instructions, ...Object.values(skill.references)].join("\n");
      expect(text, id).toContain(`lori_design.${modules[id]!.replace(".py", "")}`);
      // Every `from lori_design.<module> import a, b` names real definitions.
      for (const m of text.matchAll(/^from lori_design\.(\w+) import ([\w, ]+?)\s*(?:#.*)?$/gm)) {
        const file = `${m[1]}.py`;
        expect(sources[file], `${id}: unknown module ${m[1]}`).toBeDefined();
        for (const name of m[2]!.split(",").map((n) => n.trim()).filter(Boolean)) {
          expect(
            new RegExp(`^(class|def)\\s+${name}\\b|^${name}\\s*=`, "m").test(
              sources[file]!,
            ),
            `${id}: ${m[1]}.${name}`,
          ).toBe(true);
        }
      }
    }
  });

  it("only calls kit methods that exist in the recipes", () => {
    const owners: Record<string, [string, string[]]> = {
      spreadsheets: ["xlsx_kit.py", ["book", "sheet", "summary"]],
      presentations: ["pptx_kit.py", ["deck"]],
      pdfs: ["pdf_kit.py", ["report"]],
    };
    for (const [id, [file, variables]] of Object.entries(owners)) {
      const source = readFileSync(new URL(file, kitRoot), "utf8");
      const skill = overlaid.skills.find((s) => s.id === id)!;
      const text = [skill.instructions, ...Object.values(skill.references)].join("\n");
      const pattern = new RegExp(`\\b(?:${variables.join("|")})\\.(\\w+)\\(`, "g");
      for (const m of text.matchAll(pattern))
        expect(
          new RegExp(`^\\s+def ${m[1]}\\(`, "m").test(source),
          `${id}: ${m[0]}`,
        ).toBe(true);
    }
  });

  it("sends workbook authors to a design check that exists in the kit", () => {
    const sheets = overlaid.skills.find((s) => s.id === "spreadsheets")!;
    expect(sheets.instructions).toContain("python -m lori_design.lint");
    expect(sheets.references["references/verification.md"]).toContain("python -m lori_design.lint");
    const source = readFileSync(new URL("lint.py", kitRoot), "utf8");
    expect(source).toContain("def lint_workbook");
    expect(source).toContain('if __name__ == "__main__"');
  });

  it("parses front matter and tolerates its absence", () => {
    expect(parseSkillFile("---\nname: a\ndescription: Does a thing.\n---\n# A")).toMatchObject({
      name: "a",
      description: "Does a thing.",
    });
    expect(parseSkillFile("# Plain").body).toBe("# Plain");
  });

  it("returns the catalog unchanged when the overlay folder is missing", () => {
    expect(overlayCloudSkills(base, "/nonexistent/cloud-skills")).toBe(base);
  });
});
