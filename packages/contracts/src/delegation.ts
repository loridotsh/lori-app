import type { CatalogIdentity, EffectiveCodeDelegation } from "./index.js";

/**
 * Whether team administrators may grant a catalog item. Explicit approvals
 * and organization defaults count. A plugin or skill is also approved when
 * the organization already lets everyone install that kind personally, unless
 * the organization turned that item off: a team grant then adds nothing new.
 * Apps and providers always need an explicit approval.
 */
export function delegationApproves(
  ceiling: Pick<EffectiveCodeDelegation, "managedCatalog" | "personalInstallations" | "blockedCatalog">,
  item: Pick<CatalogIdentity, "id" | "type">,
): boolean {
  const same = (entry: Pick<CatalogIdentity, "id" | "type">) =>
    entry.type === item.type && entry.id === item.id;
  if (ceiling.managedCatalog.some(same)) return true;
  if (ceiling.blockedCatalog?.some(same)) return false;
  if (item.type === "plugin") return ceiling.personalInstallations.plugins;
  if (item.type === "skill") return ceiling.personalInstallations.skills;
  return false;
}
