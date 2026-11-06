import { readFileSync } from "node:fs";
import type {
  PolicyCatalog,
  PolicyCatalogItem,
  PolicyCatalogItemType,
} from "@lori-enterprise/contracts";

interface CatalogSourceItem {
  baseUrl?: unknown;
  description?: unknown;
  deployment?: unknown;
  featured?: unknown;
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  requires_auth?: unknown;
  routes?: unknown;
  supportedAgents?: unknown;
  defaultModel?: unknown;
}

export type ProviderGatewayRoute = "anthropic" | "openai";

export interface ProviderGatewayRouteDefinition {
  upstreamBaseUrl: string;
}

/**
 * The safe, server-side subset of the bundled provider catalog. Gateway
 * connections intentionally use these fixed upstream origins instead of an
 * administrator-supplied URL, eliminating an SSRF/configuration foot-gun.
 */
export interface ProviderGatewayDefinition {
  defaultModel?: string;
  id: string;
  kind: ProviderGatewayRoute;
  name: string;
  routes: Partial<Record<ProviderGatewayRoute, ProviderGatewayRouteDefinition>>;
  supportedAgents: string[];
}

const SOURCES: ReadonlyArray<{
  file: string;
  type: PolicyCatalogItemType;
}> = [
  { file: "apps-plugins.json", type: "app" },
  { file: "mcp-plugins.json", type: "plugin" },
  { file: "memory-plugins.json", type: "plugin" },
  { file: "skills.json", type: "skill" },
  { file: "providers.json", type: "provider" },
];

function readSource(file: string): CatalogSourceItem[] {
  const url = new URL(`../catalog/${file}`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Policy catalog ${file} must contain an array`);
  }
  return parsed as CatalogSourceItem[];
}

function normalizeItem(
  source: CatalogSourceItem,
  type: PolicyCatalogItemType,
): PolicyCatalogItem {
  if (
    typeof source.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.id) ||
    typeof source.name !== "string" ||
    source.name.trim().length === 0
  ) {
    throw new Error(`Policy catalog contains an invalid ${type} item`);
  }
  return {
    description:
      typeof source.description === "string" ? source.description.trim() : "",
    featured: source.featured === true,
    id: source.id,
    name: source.name.trim(),
    requiresAuth: source.requires_auth === true,
    type,
  };
}

const items = SOURCES.flatMap(({ file, type }) =>
  readSource(file).map((item) => normalizeItem(item, type)),
).sort((left, right) => {
  const typeOrder = left.type.localeCompare(right.type);
  return typeOrder || left.name.localeCompare(right.name);
});

const identities = new Set<string>();
const desktopIdentities = new Set<string>();
for (const item of items) {
  const identity = `${item.type}:${item.id}`;
  if (identities.has(identity)) {
    throw new Error(`Duplicate policy catalog identity: ${identity}`);
  }
  identities.add(identity);
  const desktopIdentity = `${
    item.type === "app" || item.type === "plugin"
      ? "marketplace"
      : item.type
  }:${item.id}`;
  if (desktopIdentities.has(desktopIdentity)) {
    throw new Error(`Ambiguous Lori desktop catalog identity: ${desktopIdentity}`);
  }
  desktopIdentities.add(desktopIdentity);
}

export const policyCatalog: PolicyCatalog = Object.freeze({ items });

export function assertCatalogItem(
  type: PolicyCatalogItemType,
  id: string,
): void {
  if (!identities.has(`${type}:${id}`)) {
    throw new Error(`Unknown Lori catalog item: ${type}:${id}`);
  }
}

function secureUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Provider ${label} is missing a secure upstream URL`);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Provider ${label} must use an HTTPS upstream URL`);
  }
  return url.toString().replace(/\/$/, "");
}

function providerKind(value: unknown, label: string): ProviderGatewayRoute {
  if (value === "anthropic" || value === "openai") return value;
  throw new Error(`Provider ${label} has an unsupported gateway protocol`);
}

function providerRouteDefinitions(
  source: CatalogSourceItem,
  id: string,
  kind: ProviderGatewayRoute,
): Partial<Record<ProviderGatewayRoute, ProviderGatewayRouteDefinition>> {
  const defaultUpstream = secureUrl(source.baseUrl, id);
  const result: Partial<
    Record<ProviderGatewayRoute, ProviderGatewayRouteDefinition>
  > = {};
  const rawRoutes = source.routes;
  if (rawRoutes && typeof rawRoutes === "object" && !Array.isArray(rawRoutes)) {
    for (const route of ["openai", "anthropic"] as const) {
      const config = (rawRoutes as Record<string, unknown>)[route];
      if (!config || typeof config !== "object" || Array.isArray(config)) continue;
      const baseUrl = (config as Record<string, unknown>).baseUrl;
      result[route] = { upstreamBaseUrl: secureUrl(baseUrl, `${id}/${route}`) };
    }
  }
  if (Object.keys(result).length === 0) {
    result[kind] = { upstreamBaseUrl: defaultUpstream };
  }
  return result;
}

function providerGatewayDefinitionFromSource(
  source: CatalogSourceItem,
): ProviderGatewayDefinition {
  if (
    typeof source.id !== "string" ||
    typeof source.name !== "string" ||
    source.deployment !== "cloud"
  ) {
    throw new Error("Provider catalog contains an invalid gateway provider");
  }
  const kind = providerKind(source.kind, source.id);
  const supportedAgents = Array.isArray(source.supportedAgents)
    ? source.supportedAgents.filter(
        (agent): agent is string =>
          typeof agent === "string" && /^[a-z0-9-]{1,32}$/.test(agent),
      )
    : [];
  return {
    ...(typeof source.defaultModel === "string" && source.defaultModel.trim()
      ? { defaultModel: source.defaultModel.trim() }
      : {}),
    id: source.id,
    kind,
    name: source.name.trim(),
    routes: providerRouteDefinitions(source, source.id, kind),
    supportedAgents,
  };
}

const gatewayDefinitions = new Map(
  readSource("providers.json")
    .filter((source) => source.deployment === "cloud")
    .map((source) => {
      const definition = providerGatewayDefinitionFromSource(source);
      return [definition.id, definition] as const;
    }),
);

export function providerGatewayDefinition(id: string): ProviderGatewayDefinition {
  const definition = gatewayDefinitions.get(id);
  if (!definition) {
    throw new Error(`Provider ${id} cannot be configured as an organization gateway`);
  }
  return {
    ...definition,
    routes: { ...definition.routes },
    supportedAgents: [...definition.supportedAgents],
  };
}

export function providerGatewayDefinitions(): ProviderGatewayDefinition[] {
  return [...gatewayDefinitions.values()]
    .map((definition) => providerGatewayDefinition(definition.id))
    .sort((left, right) => left.name.localeCompare(right.name));
}
