import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CatalogLogo } from "./catalog-logo";

const repository = resolve(import.meta.dirname, "../../../..");
const publicDirectory = resolve(repository, "apps/web/public");
const workExtensions = JSON.parse(
  readFileSync(
    resolve(repository, "apps/api/catalog/work-extensions.json"),
    "utf8",
  ),
) as Array<{ id: string; type: string }>;
const providerCatalog = JSON.parse(
  readFileSync(resolve(repository, "apps/api/catalog/providers.json"), "utf8"),
) as Array<{ id: string; deployment: string }>;

describe("bundled catalog logos", () => {
  it("maps every supported Work plugin/provider to a valid local image", () => {
    const entries = [
      ...workExtensions.filter((item) => item.type === "plugin"),
      ...providerCatalog
        .filter((item) => item.deployment === "cloud")
        .map((item) => ({ id: item.id, type: "provider" })),
      { id: "ollama", type: "provider" },
      { id: "vllm", type: "provider" },
    ];
    for (const entry of entries) {
      const view = render(<CatalogLogo {...entry} />);
      const source = view.container.querySelector("img")?.getAttribute("src");
      expect(source, entry.id).toMatch(
        /^\/catalog-logos\/[A-Za-z0-9.-]+\.(svg|png)$/,
      );
      const content = readFileSync(resolve(publicDirectory, source!.slice(1)));
      if (source!.endsWith(".svg")) {
        const parsed = new DOMParser().parseFromString(
          content.toString("utf8"),
          "image/svg+xml",
        );
        expect(parsed.querySelector("parsererror"), entry.id).toBeNull();
        expect(parsed.documentElement.localName, entry.id).toBe("svg");
        expect(
          parsed.querySelector("script, foreignObject"),
          entry.id,
        ).toBeNull();
      } else {
        expect(content.subarray(0, 8).toString("hex"), entry.id).toBe(
          "89504e470d0a1a0a",
        );
      }
      view.unmount();
    }
  });
  it("includes public assets at the standalone server's runtime path", () => {
    const dockerfile = readFileSync(
      resolve(repository, "apps/web/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toMatch(
      /^COPY --from=build[^\n]* \/app\/apps\/web\/public \.\/apps\/web\/public$/m,
    );
  });
  it("uses a fallback after an image failure and recovers for another provider", () => {
    const view = render(<CatalogLogo id="openai" type="provider" />);
    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector("img")).toBeNull();
    view.rerender(<CatalogLogo id="anthropic" type="provider" />);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "/catalog-logos/provider-anthropic.png",
    );
  });
});
