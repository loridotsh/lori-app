import type { EnterpriseWorkPolicy } from "@lori-enterprise/contracts";

export type WorkMode =
  "organization" | "team" | "member" | "team-member" | "viewer";
export interface WorkOverrides {
  enabled: boolean | null;
  personalInstallations: {
    plugins: boolean | null;
    providers: boolean | null;
    skills: boolean | null;
  };
  managedCatalog: EnterpriseWorkPolicy["managedCatalog"];
  providerModels: Array<{
    providerId: string;
    modelId: string;
    enabled: boolean;
  }>;
}
export interface WorkMemberView {
  effective: EnterpriseWorkPolicy;
  inherited: EnterpriseWorkPolicy;
  organization: EnterpriseWorkPolicy;
  overrides: WorkOverrides;
  finalEffective?: EnterpriseWorkPolicy;
}
export type WorkDraft = Pick<
  EnterpriseWorkPolicy,
  | "enabled"
  | "personalInstallations"
  | "managedCatalog"
  | "providerModels"
  | "forceAskMe"
  | "memoryAllowed"
>;
