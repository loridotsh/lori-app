import type {
  ManagedCatalogItem,
  PolicyCatalog,
  PolicyCatalogItemType,
} from "@lori-enterprise/contracts";

export type Decision = "allow" | "block" | "inherit";
export type PersonalKey = "plugins" | "providers" | "skills";
export type PolicyMode =
  | "member"
  | "organization"
  | "team"
  | "team-member";

export function isAssignmentMode(
  mode: PolicyMode,
): mode is "organization" | "team" {
  return mode === "organization" || mode === "team";
}

export const personalSections: ReadonlyArray<{
  description: string;
  key: PersonalKey;
  label: string;
}> = [
  {
    description:
      "Install and configure personal marketplace apps and MCP plugins.",
    key: "plugins",
    label: "Apps and plugins",
  },
  {
    description:
      "Add personal cloud or local model providers using member-owned credentials.",
    key: "providers",
    label: "AI providers",
  },
  {
    description:
      "Install and activate personal skills alongside organization assignments.",
    key: "skills",
    label: "Skills",
  },
];

export const catalogTypes: ReadonlyArray<{
  label: string;
  type: PolicyCatalogItemType;
}> = [
  { label: "Apps", type: "app" },
  { label: "Plugins", type: "plugin" },
  { label: "Skills", type: "skill" },
  { label: "Providers", type: "provider" },
];

export function catalogTypeLabel(type: PolicyCatalogItemType): string {
  return catalogTypes.find((entry) => entry.type === type)?.label ?? type;
}

export function decision(value: boolean | null | undefined): Decision {
  return value == null ? "inherit" : value ? "allow" : "block";
}

export function decisionValue(value: Decision): boolean | null {
  return value === "inherit" ? null : value === "allow";
}

export function itemIdentity(item: { id: string; type: string }): string {
  return `${item.type}:${item.id}`;
}

export function managedPayload(
  catalog: PolicyCatalog,
  catalogDecisions: Record<string, Decision>,
  mode: PolicyMode,
): ManagedCatalogItem[] {
  if (isAssignmentMode(mode)) {
    return catalog.items.flatMap((item) =>
      catalogDecisions[itemIdentity(item)] === "allow"
        ? [{ enabled: true, id: item.id, type: item.type }]
        : [],
    );
  }
  return catalog.items.flatMap((item) => {
    const value = catalogDecisions[itemIdentity(item)] ?? "inherit";
    return value === "inherit"
      ? []
      : [{ enabled: value === "allow", id: item.id, type: item.type }];
  });
}

export function initialCatalogDecisions(
  _mode: PolicyMode,
  managedCatalog: ManagedCatalogItem[],
): Record<string, Decision> {
  return Object.fromEntries(
    managedCatalog.map((item) => [
      itemIdentity(item),
      decision(item.enabled),
    ]),
  );
}

export function policyStatusLabel(
  personal: { plugins: boolean; providers: boolean; skills: boolean } | null,
): string {
  if (!personal) return "Unavailable";
  const allowed = [
    personal.plugins,
    personal.providers,
    personal.skills,
  ].filter(Boolean).length;
  if (allowed === 3) return "Personal installs allowed";
  if (allowed === 0) return "Organization catalog only";
  return "Partially restricted";
}

const personalKeys: PersonalKey[] = ["plugins", "providers", "skills"];

export function managedCatalogFingerprint(
  items: ManagedCatalogItem[],
): string {
  return [...items]
    .map((item) => `${itemIdentity(item)}:${item.enabled}`)
    .sort()
    .join("\0");
}

export function isPersonalDirty(
  current: Record<PersonalKey, Decision>,
  saved: Record<PersonalKey, Decision>,
): boolean {
  return personalKeys.some((key) => current[key] !== saved[key]);
}

export function isCatalogDirty(
  catalog: PolicyCatalog,
  mode: PolicyMode,
  current: Record<string, Decision>,
  saved: Record<string, Decision>,
): boolean {
  const currentPayload = managedPayload(catalog, current, mode);
  const savedPayload = managedPayload(catalog, saved, mode);
  return (
    managedCatalogFingerprint(currentPayload) !==
    managedCatalogFingerprint(savedPayload)
  );
}

export function isPolicyStateDirty(
  catalog: PolicyCatalog,
  mode: PolicyMode,
  current: {
    personal: Record<PersonalKey, Decision>;
    catalogDecisions: Record<string, Decision>;
  },
  saved: {
    personal: Record<PersonalKey, Decision>;
    catalogDecisions: Record<string, Decision>;
  },
): boolean {
  return (
    isPersonalDirty(current.personal, saved.personal) ||
    isCatalogDirty(catalog, mode, current.catalogDecisions, saved.catalogDecisions)
  );
}

export function hasMemberPolicyOverrides(
  personal: Record<PersonalKey, Decision>,
  catalogDecisions: Record<string, Decision>,
): boolean {
  if (personalKeys.some((key) => personal[key] !== "inherit")) {
    return true;
  }
  return Object.values(catalogDecisions).some((value) => value !== "inherit");
}
