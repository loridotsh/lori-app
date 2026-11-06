import type { EnterpriseWorkPolicy } from "@lori-enterprise/contracts";
import type { WorkDraft, WorkOverrides } from "./work-policy-types";

export function draftOf(policy: EnterpriseWorkPolicy): WorkDraft {
  return {
    enabled: policy.enabled,
    personalInstallations: { ...policy.personalInstallations },
    managedCatalog: policy.managedCatalog.map((item) => ({ ...item })),
    providerModels: policy.providerModels.map((item) => ({
      ...item,
      modelIds: [...item.modelIds],
    })),
    forceAskMe: policy.forceAskMe,
    memoryAllowed: policy.memoryAllowed,
  };
}
function changedEntries<T>(
  before: T[],
  local: T[],
  latest: T[],
  key: (entry: T) => string,
): T[] {
  const old = new Map(before.map((item) => [key(item), item]));
  const next = new Map(local.map((item) => [key(item), item]));
  const result = new Map(latest.map((item) => [key(item), item]));
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    if (JSON.stringify(old.get(id)) === JSON.stringify(next.get(id))) continue;
    if (next.has(id)) result.set(id, next.get(id)!);
    else result.delete(id);
  }
  return [...result.values()];
}
const catalogKey = (item: WorkDraft["managedCatalog"][number]) =>
  `${item.type}:${item.id}`;
const overrideKey = (item: WorkOverrides["providerModels"][number]) =>
  `${item.providerId}\0${item.modelId}`;
export function rebaseWorkDraft<T extends WorkDraft | WorkOverrides>(
  before: T,
  local: T,
  latest: T,
): T {
  const result = {
    ...latest,
    personalInstallations: { ...latest.personalInstallations },
  };
  if (before.enabled !== local.enabled) result.enabled = local.enabled;
  for (const key of ["plugins", "providers", "skills"] as const) {
    if (before.personalInstallations[key] !== local.personalInstallations[key])
      result.personalInstallations[key] = local.personalInstallations[key];
  }
  result.managedCatalog = changedEntries(
    before.managedCatalog,
    local.managedCatalog,
    latest.managedCatalog,
    catalogKey,
  );
  if (
    "forceAskMe" in local &&
    "forceAskMe" in before &&
    "forceAskMe" in result
  ) {
    if (before.forceAskMe !== local.forceAskMe)
      result.forceAskMe = local.forceAskMe;
    if (before.memoryAllowed !== local.memoryAllowed)
      result.memoryAllowed = local.memoryAllowed;
    const baseline = before.providerModels.flatMap((row) =>
      row.modelIds.map((modelId) => ({
        providerId: row.providerId,
        modelId,
        enabled: true,
      })),
    );
    const edits = local.providerModels.flatMap((row) =>
      row.modelIds.map((modelId) => ({
        providerId: row.providerId,
        modelId,
        enabled: true,
      })),
    );
    const current = (latest as WorkDraft).providerModels.flatMap((row) =>
      row.modelIds.map((modelId) => ({
        providerId: row.providerId,
        modelId,
        enabled: true,
      })),
    );
    const merged = changedEntries(baseline, edits, current, overrideKey);
    const changedProviders = local.providerModels
      .filter(
        (row) =>
          JSON.stringify(
            before.providerModels.find(
              (entry) => entry.providerId === row.providerId,
            ),
          ) !== JSON.stringify(row),
      )
      .map((row) => row.providerId);
    const ids = new Set([
      ...(latest as WorkDraft).providerModels.map((row) => row.providerId),
      ...merged.map((row) => row.providerId),
      ...changedProviders,
    ]);
    result.providerModels = [...ids].map((providerId) => ({
      providerId,
      modelIds: merged
        .filter((row) => row.providerId === providerId)
        .map((row) => row.modelId),
    }));
  } else {
    result.providerModels = changedEntries(
      (before as WorkOverrides).providerModels,
      (local as WorkOverrides).providerModels,
      (latest as WorkOverrides).providerModels,
      overrideKey,
    );
  }
  return result as T;
}
export function validateWorkDraft(
  value: WorkDraft | WorkOverrides,
): string | null {
  if (value.managedCatalog.length > 500)
    return "Work supports up to 500 catalog decisions. Remove an assignment before adding another.";
  if (
    new Set(value.managedCatalog.map(catalogKey)).size !==
    value.managedCatalog.length
  )
    return "A Work assignment is listed more than once. Review the duplicated assignment.";
  if ("forceAskMe" in value) {
    if (value.providerModels.length > 64)
      return "Work supports up to 64 providers.";
    if (value.providerModels.some((row) => row.modelIds.length > 32))
      return "Assign up to 32 models per Work provider.";
  } else if (value.providerModels.length > 2048)
    return "Work supports up to 2,048 individual model decisions.";
  const ids =
    "forceAskMe" in value
      ? value.providerModels.flatMap((row) => row.modelIds)
      : value.providerModels.map((row) => row.modelId);
  if (
    ids.some(
      (id) => !id.trim() || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id),
    )
  )
    return "Use model IDs of 1–128 characters without control characters.";
  return null;
}
