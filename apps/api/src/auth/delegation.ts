import { delegationApproves } from "@lori-enterprise/contracts";
import type {
  CatalogIdentity,
  EffectiveCodeDelegation,
  EffectiveWorkDelegation,
  ManagedCatalogItem,
  PersonalInstallationPolicy,
  WorkPolicyInput,
  WorkProviderModels,
} from "@lori-enterprise/contracts";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { IdentityError } from "./errors.js";

/**
 * The delegation ceiling bounds what team administrators may grant. The
 * organization defaults are always part of it; the stored document lists
 * the additional approvals. Both resolution and writes apply the same rules.
 */
const Identity = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    type: z.enum(["app", "plugin", "provider", "skill"]),
  })
  .strict();
const Personal = z
  .object({ plugins: z.boolean(), providers: z.boolean(), skills: z.boolean() })
  .strict();
const Model = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

// The approved set is the union of what every team may grant, so its limits
// sit well above any single team policy (500 catalog items, 64 providers,
// 2048 model overrides per member).
const MAX_APPROVED_CATALOG = 5000;
const MAX_APPROVED_PROVIDERS = 512;
const MAX_APPROVED_MODELS_PER_PROVIDER = 4096;

export const CodeDelegationSchema = z
  .object({
    personalInstallations: Personal,
    managedCatalog: z.array(Identity).max(MAX_APPROVED_CATALOG),
  })
  .strict();
export const WorkDelegationSchema = z
  .object({
    enabled: z.boolean(),
    personalInstallations: Personal,
    managedCatalog: z.array(Identity).max(MAX_APPROVED_CATALOG),
    providerModels: z
      .array(
        z
          .object({
            providerId: Identity.shape.id,
            modelIds: z.array(Model).max(MAX_APPROVED_MODELS_PER_PROVIDER),
          })
          .strict(),
      )
      .max(MAX_APPROVED_PROVIDERS),
  })
  .strict();

/** The stored document body, or null when it is missing or not version 1. */
function storedBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, ...rest } = value as Record<string, unknown>;
  return version === 1 ? rest : null;
}

const noPersonal = (): PersonalInstallationPolicy => ({
  plugins: false,
  providers: false,
  skills: false,
});

const key = (item: Pick<CatalogIdentity, "id" | "type">) =>
  `${item.type}:${item.id}`;

function sortedIdentities(items: Iterable<CatalogIdentity>): CatalogIdentity[] {
  const unique = new Map<string, CatalogIdentity>();
  for (const item of items) unique.set(key(item), { id: item.id, type: item.type });
  return [...unique.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

function sortedModels(
  rows: Iterable<{ providerId: string; modelIds: Iterable<string> }>,
): WorkProviderModels[] {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = map.get(row.providerId) ?? new Set<string>();
    for (const id of row.modelIds) ids.add(id);
    map.set(row.providerId, ids);
  }
  return [...map]
    .filter(([, ids]) => ids.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([providerId, ids]) => ({ providerId, modelIds: [...ids].sort() }));
}

/** A missing or corrupt stored document approves nothing beyond the defaults (fail closed). */
export function storedCodeDelegation(value: unknown): EffectiveCodeDelegation {
  const parsed = CodeDelegationSchema.safeParse(storedBody(value));
  return parsed.success
    ? parsed.data
    : { personalInstallations: noPersonal(), managedCatalog: [] };
}

export function storedWorkDelegation(value: unknown): EffectiveWorkDelegation {
  const parsed = WorkDelegationSchema.safeParse(storedBody(value));
  return parsed.success
    ? parsed.data
    : {
        enabled: false,
        personalInstallations: noPersonal(),
        managedCatalog: [],
        providerModels: [],
      };
}

export function normalizeCodeDelegation(
  input: EffectiveCodeDelegation,
): EffectiveCodeDelegation {
  return {
    personalInstallations: { ...input.personalInstallations },
    managedCatalog: sortedIdentities(input.managedCatalog),
  };
}

export function normalizeWorkDelegation(
  input: EffectiveWorkDelegation,
): EffectiveWorkDelegation {
  return {
    enabled: input.enabled,
    personalInstallations: { ...input.personalInstallations },
    managedCatalog: sortedIdentities(input.managedCatalog),
    providerModels: sortedModels(input.providerModels),
  };
}

/**
 * The stored form. A document the reader would not accept is refused here, so
 * an approval can never be written in a shape that later fails closed and
 * silently withdraws every team grant.
 */
export function storedDocument(
  input: EffectiveCodeDelegation | EffectiveWorkDelegation,
): string {
  const { blockedCatalog: _blocked, ...body } = input as EffectiveWorkDelegation;
  const schema = "providerModels" in body ? WorkDelegationSchema : CodeDelegationSchema;
  if (!schema.safeParse(body).success) {
    throw new IdentityError(
      409,
      "delegation_limit_reached",
      "Team delegation has reached its size limit. Remove approvals that are no longer needed in team delegation, then try again.",
    );
  }
  return JSON.stringify({ version: 1, ...body });
}

/** Stored approvals plus the organization defaults. */
export function effectiveCodeDelegation(
  stored: EffectiveCodeDelegation,
  organization: {
    personalInstallations: PersonalInstallationPolicy;
    managedCatalog: ManagedCatalogItem[];
  },
): EffectiveCodeDelegation {
  // Items the organization turned off stay off for teams, even when everyone
  // may install that kind personally.
  const blocked = organization.managedCatalog.filter((item) => !item.enabled);
  return {
    ...normalizeCodeDelegation({
      personalInstallations: {
        plugins:
          stored.personalInstallations.plugins ||
          organization.personalInstallations.plugins,
        providers:
          stored.personalInstallations.providers ||
          organization.personalInstallations.providers,
        skills:
          stored.personalInstallations.skills ||
          organization.personalInstallations.skills,
      },
      managedCatalog: [
        ...stored.managedCatalog,
        ...organization.managedCatalog.filter((item) => item.enabled),
      ],
    }),
    ...(blocked.length ? { blockedCatalog: sortedIdentities(blocked) } : {}),
  };
}

export function effectiveWorkDelegation(
  stored: EffectiveWorkDelegation,
  organization: WorkPolicyInput,
): EffectiveWorkDelegation {
  const blocked = organization.managedCatalog.filter((item) => !item.enabled);
  return {
    ...effectiveWorkDelegationWithoutBlocks(stored, organization),
    ...(blocked.length
      ? { blockedCatalog: sortedIdentities(blocked) }
      : {}),
  };
}

function effectiveWorkDelegationWithoutBlocks(
  stored: EffectiveWorkDelegation,
  organization: WorkPolicyInput,
): EffectiveWorkDelegation {
  return normalizeWorkDelegation({
    enabled: stored.enabled || organization.enabled,
    personalInstallations: {
      plugins:
        stored.personalInstallations.plugins ||
        organization.personalInstallations.plugins,
      providers:
        stored.personalInstallations.providers ||
        organization.personalInstallations.providers,
      skills:
        stored.personalInstallations.skills ||
        organization.personalInstallations.skills,
    },
    managedCatalog: [
      ...stored.managedCatalog,
      ...organization.managedCatalog.filter((item) => item.enabled),
    ],
    providerModels: [...stored.providerModels, ...organization.providerModels],
  });
}

/** Loads the stored Code approvals and the organization defaults they extend. */
export async function loadCodeDelegation(
  database: Pool | PoolClient,
  organizationId: string,
): Promise<{ stored: EffectiveCodeDelegation; effective: EffectiveCodeDelegation }> {
  const policy = await database.query<{
    delegation: unknown;
    allow_personal_plugins: boolean;
    allow_personal_providers: boolean;
    allow_personal_skills: boolean;
  }>(
    `
      SELECT delegation, allow_personal_plugins, allow_personal_providers, allow_personal_skills
      FROM organization_policies WHERE organization_id = $1
    `,
    [organizationId],
  );
  const catalog = await database.query<{
    enabled: boolean;
    item_type: CatalogIdentity["type"];
    item_id: string;
  }>(
    `
      SELECT item_type, item_id, enabled FROM organization_catalog_policies
      WHERE organization_id = $1
    `,
    [organizationId],
  );
  const row = policy.rows[0];
  const stored = storedCodeDelegation(row?.delegation);
  return {
    stored,
    effective: effectiveCodeDelegation(stored, {
      managedCatalog: catalog.rows.map((item) => ({
        enabled: item.enabled,
        id: item.item_id,
        type: item.item_type,
      })),
      personalInstallations: {
        plugins: row?.allow_personal_plugins ?? false,
        providers: row?.allow_personal_providers ?? false,
        skills: row?.allow_personal_skills ?? false,
      },
    }),
  };
}

export function catalogApproved(
  ceiling: Pick<EffectiveCodeDelegation, "managedCatalog" | "personalInstallations" | "blockedCatalog">,
  item: Pick<CatalogIdentity, "id" | "type">,
): boolean {
  return delegationApproves(ceiling, item);
}

export function modelApproved(
  ceiling: Pick<EffectiveWorkDelegation, "providerModels">,
  providerId: string,
  modelId: string,
): boolean {
  return ceiling.providerModels.some(
    (row) => row.providerId === providerId && row.modelIds.includes(modelId),
  );
}

/** A team contribution with everything outside the ceiling removed. */
export function boundWorkContribution(
  contribution: WorkPolicyInput,
  ceiling: EffectiveWorkDelegation,
): WorkPolicyInput {
  return {
    ...contribution,
    enabled: contribution.enabled && ceiling.enabled,
    personalInstallations: {
      plugins:
        contribution.personalInstallations.plugins &&
        ceiling.personalInstallations.plugins,
      providers:
        contribution.personalInstallations.providers &&
        ceiling.personalInstallations.providers,
      skills:
        contribution.personalInstallations.skills &&
        ceiling.personalInstallations.skills,
    },
    managedCatalog: contribution.managedCatalog.filter(
      (item) => !item.enabled || catalogApproved(ceiling, item),
    ),
    providerModels: contribution.providerModels
      .map((row) => ({
        providerId: row.providerId,
        modelIds: row.modelIds.filter((model) =>
          modelApproved(ceiling, row.providerId, model),
        ),
      }))
      .filter((row) => row.modelIds.length > 0),
  };
}

export interface DelegationExcess {
  personalInstallations: (keyof PersonalInstallationPolicy)[];
  managedCatalog: CatalogIdentity[];
  providerModels: { providerId: string; modelId: string }[];
  enabled: boolean;
}

function emptyExcess(): DelegationExcess {
  return {
    enabled: false,
    managedCatalog: [],
    personalInstallations: [],
    providerModels: [],
  };
}

function hasExcess(excess: DelegationExcess): boolean {
  return (
    excess.enabled ||
    excess.managedCatalog.length > 0 ||
    excess.personalInstallations.length > 0 ||
    excess.providerModels.length > 0
  );
}

/**
 * The new team grants that exceed the ceiling, or null. Only grants that are
 * new relative to `previous` count, so an existing grant that later fell
 * outside the ceiling can still be saved unchanged (it does not take effect).
 */
export function delegationExcess(input: {
  ceiling: EffectiveCodeDelegation | EffectiveWorkDelegation;
  previous?: {
    enabled?: boolean | null;
    personalInstallations?: Partial<
      Record<keyof PersonalInstallationPolicy, boolean | null>
    >;
    managedCatalog?: ManagedCatalogItem[];
    providerModels?: { providerId: string; modelId: string }[];
  };
  next: {
    enabled?: boolean | null;
    personalInstallations?: Partial<
      Record<keyof PersonalInstallationPolicy, boolean | null>
    >;
    managedCatalog?: ManagedCatalogItem[];
    providerModels?: { providerId: string; modelId: string }[];
  };
}): DelegationExcess | null {
  const { ceiling, next, previous = {} } = input;
  const excess = emptyExcess();
  if (
    "enabled" in ceiling &&
    next.enabled === true &&
    previous.enabled !== true &&
    !ceiling.enabled
  )
    excess.enabled = true;
  for (const flag of ["plugins", "providers", "skills"] as const) {
    if (
      next.personalInstallations?.[flag] === true &&
      previous.personalInstallations?.[flag] !== true &&
      !ceiling.personalInstallations[flag]
    )
      excess.personalInstallations.push(flag);
  }
  const before = new Set(
    (previous.managedCatalog ?? [])
      .filter((item) => item.enabled)
      .map((item) => key(item)),
  );
  for (const item of next.managedCatalog ?? []) {
    if (item.enabled && !before.has(key(item)) && !catalogApproved(ceiling, item))
      excess.managedCatalog.push({ id: item.id, type: item.type });
  }
  if ("providerModels" in ceiling) {
    const modelsBefore = new Set(
      (previous.providerModels ?? []).map((m) => `${m.providerId}\0${m.modelId}`),
    );
    for (const model of next.providerModels ?? []) {
      if (
        !modelsBefore.has(`${model.providerId}\0${model.modelId}`) &&
        !modelApproved(ceiling, model.providerId, model.modelId)
      )
        excess.providerModels.push(model);
    }
  }
  return hasExcess(excess) ? excess : null;
}

export function delegationRefused(excess: DelegationExcess): IdentityError {
  const named = [
    ...(excess.enabled ? ["Work access"] : []),
    ...excess.personalInstallations.map((flag) => `personal ${flag}`),
    ...excess.managedCatalog.map((item) => `${item.type} ${item.id}`),
    ...excess.providerModels.map(
      (model) => `model ${model.providerId}/${model.modelId}`,
    ),
  ];
  const shown = named.slice(0, 5).join(", ");
  return new IdentityError(
    403,
    "delegation_not_approved",
    `Not approved for team administrators: ${shown}${named.length > 5 ? `, and ${named.length - 5} more` : ""}. An organization administrator must approve it in team delegation first.`,
  );
}

/** Adds an organization administrator's explicit team grants to the stored ceiling. */
export function approveCodeExcess(
  stored: EffectiveCodeDelegation,
  excess: DelegationExcess,
): EffectiveCodeDelegation {
  return normalizeCodeDelegation({
    personalInstallations: {
      plugins:
        stored.personalInstallations.plugins ||
        excess.personalInstallations.includes("plugins"),
      providers:
        stored.personalInstallations.providers ||
        excess.personalInstallations.includes("providers"),
      skills:
        stored.personalInstallations.skills ||
        excess.personalInstallations.includes("skills"),
    },
    managedCatalog: [...stored.managedCatalog, ...excess.managedCatalog],
  });
}

export function approveWorkExcess(
  stored: EffectiveWorkDelegation,
  excess: DelegationExcess,
): EffectiveWorkDelegation {
  const code = approveCodeExcess(stored, excess);
  return normalizeWorkDelegation({
    ...code,
    enabled: stored.enabled || excess.enabled,
    providerModels: [
      ...stored.providerModels,
      ...excess.providerModels.map((model) => ({
        providerId: model.providerId,
        modelIds: [model.modelId],
      })),
    ],
  });
}

export function workModelRows(
  rows: WorkProviderModels[],
): { providerId: string; modelId: string }[] {
  return rows.flatMap((row) =>
    row.modelIds.map((modelId) => ({ providerId: row.providerId, modelId })),
  );
}
