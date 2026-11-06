import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertCatalogItem, policyCatalog } from "./catalog.js";

const catalogFiles = [
  { file: "apps-plugins.json", type: "app" },
  { file: "mcp-plugins.json", type: "plugin" },
  { file: "memory-plugins.json", type: "plugin" },
  { file: "providers.json", type: "provider" },
  { file: "skills.json", type: "skill" },
] as const;

describe("policy catalog", () => {
  it("loads every supported Lori policy surface with unique identities", () => {
    const types = new Set(policyCatalog.items.map((item) => item.type));
    expect(types).toEqual(new Set(["app", "plugin", "provider", "skill"]));
    const identities = policyCatalog.items.map(
      (item) => `${item.type}:${item.id}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
    const desktopIdentities = policyCatalog.items.map(
      (item) =>
        `${
          item.type === "app" || item.type === "plugin"
            ? "marketplace"
            : item.type
        }:${item.id}`,
    );
    expect(new Set(desktopIdentities).size).toBe(desktopIdentities.length);
    expect(policyCatalog.items.length).toBeGreaterThan(50);
  });

  it("loads every item from each self-contained catalog source", () => {
    for (const { file, type } of catalogFiles) {
      const source: unknown = JSON.parse(
        readFileSync(new URL(`../catalog/${file}`, import.meta.url), "utf8"),
      );
      expect(Array.isArray(source), file).toBe(true);
      if (!Array.isArray(source)) continue;
      expect(source.length, file).toBeGreaterThan(0);
      for (const item of source) {
        expect(item, file).toEqual(
          expect.objectContaining({ id: expect.any(String) }),
        );
        const id = (item as { id: string }).id;
        expect(policyCatalog.items, `${file}:${id}`).toContainEqual(
          expect.objectContaining({ id, type }),
        );
      }
    }
  });

  it("rejects catalog identities outside this Lori release", () => {
    expect(() => assertCatalogItem("provider", "openai")).not.toThrow();
    expect(() => assertCatalogItem("plugin", "not-a-real-item")).toThrow(
      "Unknown Lori catalog item",
    );
  });
});
