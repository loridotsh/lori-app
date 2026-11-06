import { readFileSync } from "node:fs";
import type {
  ManagedCatalogItem,
  PolicyCatalog,
  PolicyCatalogItem,
} from "@lori-enterprise/contracts";
import { providerGatewayDefinition } from "../catalog.js";
import { IdentityError } from "./identity-service.js";

// Extension IDs are copied from Lori's app-bundled Work catalog.rs and its SKILLS
// manifest. They deliberately do not import the coding marketplace catalog.
const extensions = JSON.parse(
  readFileSync(
    new URL("../../catalog/work-extensions.json", import.meta.url),
    "utf8",
  ),
) as PolicyCatalogItem[];
// Explicit Work-to-company-gateway mapping. Google uses the gateway's OpenAI
// compatible route; Work's native personal Gemini connection stays independent.
export const WORK_GATEWAY_PROVIDER_IDS = [
  "0g",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "mistral",
  "together",
  "fireworks",
  "akashml",
  "venice",
] as const;
export const workCatalog: PolicyCatalog = {
  items: [
    ...extensions,
    ...WORK_GATEWAY_PROVIDER_IDS.map((id): PolicyCatalogItem => {
      const provider = providerGatewayDefinition(id);
      return {
        id,
        name: provider.name,
        description: "Organization-managed Work model connection.",
        type: "provider",
        featured: id === "0g",
        requiresAuth: true,
      };
    }),
  ],
};
export function validateWorkCatalog(items: ManagedCatalogItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key))
      throw new IdentityError(
        400,
        "duplicate_catalog_item",
        "A Work catalog item may only appear once.",
      );
    if (
      !workCatalog.items.some(
        (candidate) => candidate.id === item.id && candidate.type === item.type,
      )
    )
      throw new IdentityError(
        400,
        "unknown_work_catalog_item",
        "This item is not in the Work catalog.",
      );
    seen.add(key);
  }
}
