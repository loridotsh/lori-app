export type OperationalState =
  | "operational"
  | "degraded"
  | "unavailable"
  | "not_configured";

export interface CapabilityStatus {
  auditLog: boolean;
  curatedMarketplace: boolean;
  enrollment: boolean;
  gateway: boolean;
  sso: boolean;
  usageAnalytics: boolean;
}

export interface SystemStatus {
  capabilities: CapabilityStatus;
  deployment: {
    api: OperationalState;
    authentication: OperationalState;
    database: OperationalState;
    tls: OperationalState;
  };
  environment: string;
  generatedAt: string;
  publicUrl: string;
  version: string;
}

export interface HealthStatus {
  status: "ok" | "not_ready";
  timestamp: string;
}

import type {
  AssignableOrganizationRole,
  OrganizationAuthority,
  OrganizationRole,
} from "./authority.js";

export type Role = OrganizationRole;
/** Roles an invitation may carry. Ownership is never invited, only transferred. */
export type InvitationRole = AssignableOrganizationRole;

export type SetupState = "requires_setup" | "ready";

export type SetupTokenSource = "docker_compose" | "local_development";

export interface SetupTokenGuidance {
  /** Where the operator obtains the one-time setup token. */
  source: SetupTokenSource;
  /** ISO-8601 expiry of the current setup token window (Docker deployments). */
  expiresAt?: string;
  /**
   * Fixed development token for `npm run dev` only. Never returned in
   * production.
   */
  developmentToken?: string;
}

export interface SetupStatus {
  publicUrl: string;
  /** True on the hosted cloud, where anyone may create an account. */
  publicSignup?: boolean;
  state: SetupState;
  /** Present while the deployment still needs its first administrator. */
  tokenGuidance?: SetupTokenGuidance;
}

/** An individual's one-person workspace, or an organization others can join. */
export type WorkspaceKind = "personal" | "enterprise";

export interface Workspace {
  active: boolean;
  id: string;
  kind: WorkspaceKind;
  name: string;
  role: Role;
}

export interface WorkspacesResponse {
  /** Whether this deployment lets people create workspaces themselves. */
  canCreate: boolean;
  /** Whether this person may still add their one personal workspace. */
  canCreatePersonal: boolean;
  workspaces: Workspace[];
}

/** Where someone is after leaving: null when they have no workspace left. */
export interface LeaveWorkspaceResult {
  organization: { id: string; kind?: WorkspaceKind; name: string } | null;
}

export type CreateWorkspaceInput =
  | { kind: "personal" }
  | { kind: "enterprise"; organizationName: string };

export interface Viewer {
  /** Signed in to the hosted cloud rather than a self-hosted deployment. */
  cloud?: boolean;
  organization: {
    id: string;
    /** Absent means an enterprise, including from older API versions. */
    kind?: WorkspaceKind;
    name: string;
  };
  role: Role;
  /** Server-computed organization authority; present on every current API. */
  authority?: OrganizationAuthority;
  teamAdmin?: boolean;
  user: {
    email: string;
    id: string;
    name: string;
  };
  usageAnalytics?: {
    canManage: boolean;
    canView: boolean;
  };
}

export interface OwnershipTransferInput {
  memberId: string;
  /** The organization access revision the Owner reviewed. */
  expectedRevision: number;
}

export interface OwnershipTransferResult {
  previousOwnerMemberId: string;
  ownerMemberId: string;
  revision: number;
}

export interface Person {
  createdAt: string;
  email: string;
  memberId: string;
  name: string;
  role: Role;
  userId: string;
}

export type InvitationState = "pending" | "accepted" | "revoked" | "expired";

export interface PendingInvitation {
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedByName: string;
  role: InvitationRole;
  state: InvitationState;
}

export interface PeopleResponse {
  invitations: PendingInvitation[];
  members: Person[];
  /** Organization access revision for optimistic role and ownership changes. */
  revision?: number;
}

export type JoinState = "pending" | "invalid" | "expired" | "revoked" | "used";

export interface JoinPreview {
  email?: string;
  expiresAt?: string;
  inviterName?: string;
  organizationName?: string;
  role?: InvitationRole;
  state: JoinState;
}

export interface InviteCreated {
  invitation: PendingInvitation;
  url: string;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export const DESKTOP_PROTOCOL_VERSION = 1 as const;

export type DesktopPlatform = "macos" | "windows" | "linux";

export interface PersonalInstallationPolicy {
  plugins: boolean;
  providers: boolean;
  skills: boolean;
}

export type PersonalInstallationDecisionSource =
  | "member_override"
  | "organization"
  | "team";

export interface PolicySourceTeam {
  id: string;
  name: string;
  slug: string;
}

export interface PersonalInstallationDecisionAttribution {
  source: PersonalInstallationDecisionSource;
  teams?: PolicySourceTeam[];
}

export interface PersonalInstallationAttribution {
  plugins: PersonalInstallationDecisionAttribution;
  providers: PersonalInstallationDecisionAttribution;
  skills: PersonalInstallationDecisionAttribution;
}

export type ManagedCatalogDecisionSource =
  | "member_override"
  | "organization"
  | "team";

export interface ManagedCatalogItemAttribution extends ManagedCatalogItem {
  memberOverride?: boolean;
  organizationAssigned: boolean;
  source: ManagedCatalogDecisionSource;
  teams: PolicySourceTeam[];
}

export interface OrganizationPolicy {
  managedCatalog: ManagedCatalogItem[];
  managedCatalogAttribution?: ManagedCatalogItemAttribution[];
  personalInstallationAttribution?: PersonalInstallationAttribution;
  personalInstallations: PersonalInstallationPolicy;
  revision: number;
  updatedAt: string;
  updatedByName?: string;
}

export type PolicyCatalogItemType = "app" | "plugin" | "provider" | "skill";

export interface PolicyCatalogItem {
  description: string;
  featured: boolean;
  id: string;
  name: string;
  requiresAuth: boolean;
  type: PolicyCatalogItemType;
}

export interface CatalogIdentity {
  id: string;
  type: PolicyCatalogItemType;
}

/**
 * What team administrators may distribute beyond the organization defaults.
 * Organization defaults are always approved; team grants outside the union
 * of both never take effect.
 */
export interface CodeDelegationPolicy {
  personalInstallations: PersonalInstallationPolicy;
  managedCatalog: CatalogIdentity[];
  /** Organization policy revision for optimistic writes. */
  revision: number;
  /** Reads only: the stored approvals plus the organization defaults. */
  effective?: EffectiveCodeDelegation;
}

export interface WorkDelegationPolicy {
  enabled: boolean;
  personalInstallations: PersonalInstallationPolicy;
  managedCatalog: CatalogIdentity[];
  providerModels: WorkProviderModels[];
  revision: number;
  /** Reads only: everything the organization approves (approvals plus defaults). */
  effective?: EffectiveWorkDelegation;
}

/** The ceiling actually applied to team grants: stored approvals plus defaults. */
export interface EffectiveCodeDelegation {
  personalInstallations: PersonalInstallationPolicy;
  managedCatalog: CatalogIdentity[];
  /** Items the organization explicitly turned off; never approved through personal installation. */
  blockedCatalog?: CatalogIdentity[];
}
export interface EffectiveWorkDelegation extends EffectiveCodeDelegation {
  enabled: boolean;
  providerModels: WorkProviderModels[];
}

export interface PolicyCatalog {
  /** Provider IDs with a company-owned server connection configured. */
  connectedOrganizationProviderIds?: string[];
  items: PolicyCatalogItem[];
}

export interface MemberPolicyOverrides {
  managedCatalog: ManagedCatalogItem[];
  personalInstallations: {
    plugins: boolean | null;
    providers: boolean | null;
    skills: boolean | null;
  };
}

export interface MemberPolicy {
  effective: OrganizationPolicy;
  inherited: OrganizationPolicy;
  member: Person;
  organization: OrganizationPolicy;
  overrides: MemberPolicyOverrides;
}

export type TeamRole = "team_admin" | "member";

export interface Team {
  createdAt: string;
  description?: string;
  id: string;
  memberCount: number;
  name: string;
  slug: string;
  updatedAt: string;
}

export interface TeamSummary {
  id: string;
  memberCount: number;
  name: string;
  slug: string;
}

export interface TeamsResponse {
  pageInfo?: PageInfo;
  teams: Team[];
}

export interface TeamMember {
  email: string;
  joinedAt: string;
  memberId: string;
  name: string;
  role: TeamRole;
  teamMemberId: string;
}

export interface TeamMembersResponse {
  members: TeamMember[];
  pageInfo?: PageInfo;
  teamAdminCount?: number;
}

export interface EligibleTeamMembersResponse {
  members: Person[];
  pageInfo?: PageInfo;
}

export interface TeamPolicy {
  /** What this team may grant; anything else is shown as not approved. */
  delegation?: EffectiveCodeDelegation;
  managedCatalog: ManagedCatalogItem[];
  organizationPersonalInstallations: PersonalInstallationPolicy;
  personalInstallations: PersonalInstallationPolicy;
  revision: number;
  updatedAt: string;
  updatedByName?: string;
}

export interface TeamMemberPolicy {
  /** @deprecated Use teamContribution for the team-local result. */
  effective: TeamPolicy;
  finalEffective: OrganizationPolicy;
  member: Person;
  overrides: MemberPolicyOverrides;
  team: TeamPolicy;
  teamContribution: TeamPolicy;
}

export interface TeamPolicyPreview {
  catalogGrantsAdded: number;
  catalogGrantsRemoved: number;
  personalGrantsAdded: number;
  personalGrantsRemoved: number;
  potentiallyAffectedMemberCount: number;
  revision: number;
}

export interface PageInfo {
  hasMore: boolean;
  limit: number;
  offset: number;
  total: number;
}

export interface BulkTeamMembersResponse {
  added: TeamMember[];
  skippedMemberIds: string[];
}

export interface AuditEvent {
  action: string;
  actor?: { email: string; id: string; name: string };
  createdAt: string;
  id: string;
  metadata: Record<string, unknown>;
  subjectId?: string;
  subjectType?: string;
}

export interface AuditEventsResponse {
  events: AuditEvent[];
  pageInfo: PageInfo;
}

export type DeviceStatus = "connected" | "expired" | "revoked";

export type DesktopInventorySyncStatus = "synced" | "error";

export interface DesktopInventoryItem {
  enabled: boolean;
  enabledAgents: string[];
  id: string;
  name: string;
  organizationManaged: boolean;
  type: PolicyCatalogItemType;
}

export interface DesktopInventoryReport {
  items: DesktopInventoryItem[];
  policyRevision: number;
  syncError: string | null;
  syncStatus: DesktopInventorySyncStatus;
}

export interface DeviceInventory extends DesktopInventoryReport {
  reportedAt: string;
}

export interface Device {
  appVersion: string;
  createdAt: string;
  currentPolicyRevision: number;
  id: string;
  inventory?: DeviceInventory;
  workInventory?: DeviceInventory;
  lastSeenAt?: string;
  name: string;
  owner: {
    email: string;
    name: string;
    userId: string;
  };
  platform: DesktopPlatform;
  revokedAt?: string;
  status: DeviceStatus;
}

export interface DevicesResponse {
  devices: Device[];
}

export interface EnrollmentAuthorization {
  deepLink: string;
  expiresAt: string;
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  returnUrl?: string;
}

export interface EnrollmentTokenResponse {
  accessToken: string;
  deviceId: string;
  expiresIn: number;
  refreshExpiresIn: number;
  refreshToken: string;
  tokenType: "Bearer";
}

export interface ManagedCatalogItem {
  enabled: boolean;
  id: string;
  type: PolicyCatalogItemType;
}

/**
 * A company-owned provider connection. Its upstream credential never leaves
 * the Enterprise API; enrolled Lori installations receive a short-lived,
 * device-scoped gateway token separately.
 */
export interface OrganizationProviderGateway {
  createdAt: string;
  credentialConfigured: true;
  enabledModels: string[];
  id: string;
  policyRevision: number;
  providerId: string;
  providerKind: "anthropic" | "openai";
  providerName: string;
  requestsPerMinute: number;
  updatedAt: string;
}

export interface OrganizationProviderGatewaysResponse {
  providerGateways: OrganizationProviderGateway[];
}

export interface OrganizationProviderGatewayCatalogItem {
  defaultModel?: string;
  id: string;
  kind: "anthropic" | "openai";
  name: string;
}

export interface OrganizationProviderGatewayCatalogResponse {
  providers: OrganizationProviderGatewayCatalogItem[];
}

/**
 * Non-secret metadata used by Lori to materialize an organization-managed
 * provider in coding-tool configuration. Access tokens are intentionally not
 * part of desktop bootstrap or persisted connection state.
 */
export interface ManagedProviderGateway {
  enabledModels: string[];
  gatewayId: string;
  kind: "anthropic" | "openai";
  name: string;
  providerId: string;
  routeBaseUrls: Partial<Record<"anthropic" | "openai", string>>;
  supportedAgents: string[];
}

export interface ManagedProviderCredential {
  expiresAt: string;
  gatewayId: string;
  token: string;
}

export interface ManagedProviderCredentialsResponse {
  providers: ManagedProviderCredential[];
}

export interface DesktopBootstrap {
  device: {
    appVersion: string;
    id: string;
    name: string;
    platform: DesktopPlatform;
  };
  managedCatalog: ManagedCatalogItem[];
  organization: Viewer["organization"];
  policy: OrganizationPolicy;
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION;
  server: {
    origin: string;
    version: string;
  };
  managedProviderGateways?: ManagedProviderGateway[];
  workPolicy?: EnterpriseWorkPolicy;
  workManagedProviderGateways?: ManagedProviderGateway[];
  teams?: TeamSummary[];
  usageAnalytics?: DesktopUsageAnalyticsPolicy;
  user: Viewer["user"] & {
    /**
     * Legacy role: older clients accept only "admin" | "member", so the Owner
     * is reported as "admin". Server checks always use the actual role.
     */
    role: InvitationRole;
    /** The actual organization role, for updated clients. */
    organizationRole?: Role;
    capabilities?: OrganizationAuthority["capabilities"];
  };
}

export type UsageAnalyticsRetentionDays = 30 | 90 | 180 | 365 | null;

export type UsageMemberVisibilityOverride = "inherit" | "show" | "hide";

export interface DesktopUsageAnalyticsPolicy {
  enabled: boolean;
  epoch: string;
  startedAt: string;
}

export interface UsageAnalyticsSettings {
  collectionEnabled: boolean;
  collectionStartedAt: string;
  memberVisibilityDefault: boolean;
  retentionDays: UsageAnalyticsRetentionDays;
  revision: number;
  updatedAt: string;
  updatedByName?: string;
}

export interface MemberUsageVisibility {
  effective: boolean;
  member: Person;
  override: UsageMemberVisibilityOverride;
  revision: number;
}

export interface DesktopUsageSnapshot {
  agentId: string;
  appVersion: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCoveredTokens: number;
  estimatedCostMicrousd: number;
  inputTokens: number;
  model?: string;
  outputTokens: number;
  pricingVersion: string;
  totalTurns: number;
  usageDate: string;
}

export interface DesktopUsageSnapshotBatch {
  epoch: string;
  sourceId: string;
  snapshots: DesktopUsageSnapshot[];
}

export interface DesktopUsageIngestResponse {
  accepted: number;
  receivedAt: string;
}

export type UsageAnalyticsGranularity = "day" | "week" | "month";

export interface UsageAnalyticsRange {
  from: string;
  granularity: UsageAnalyticsGranularity;
  to: string;
}

export interface UsageAnalyticsTotals {
  activeMembers: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCoveragePercent: number;
  estimatedCostMicrousd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalTurns: number;
}

export interface UsageAnalyticsSeriesPoint {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostMicrousd: number;
  inputTokens: number;
  label: string;
  outputTokens: number;
  totalTokens: number;
  totalTurns: number;
}

export interface UsageAnalyticsBreakdown {
  /** Fraction of this row's tokens with known cost, when available. */
  costCoveragePercent?: number;
  estimatedCostMicrousd: number;
  id: string;
  label: string;
  totalTokens: number;
  totalTurns: number;
}

export interface UsageAnalyticsResponse {
  /** Known-counter and pricing coverage for server-collected Cloud rounds. */
  reporting?: {
    cloud: {
      rounds: number;
      inputKnownRounds: number;
      outputKnownRounds: number;
      cacheReadKnownRounds: number;
      cacheWriteKnownRounds: number;
      unpricedRounds: number;
    };
  };
  agents: UsageAnalyticsBreakdown[];
  collectionEnabled: boolean;
  comparison?: {
    estimatedCostPercent: number | null;
    totalTokensPercent: number | null;
    totalTurnsPercent: number | null;
  };
  freshness: {
    lastReceivedAt?: string;
    stale: boolean;
  };
  models: UsageAnalyticsBreakdown[];
  range: UsageAnalyticsRange;
  scope: {
    memberId?: string;
    name: string;
    type: "organization" | "member";
  };
  series: UsageAnalyticsSeriesPoint[];
  totals: UsageAnalyticsTotals;
}

export interface UsageAnalyticsMemberRow extends UsageAnalyticsBreakdown {
  email?: string;
  lastReceivedAt?: string;
  memberId?: string;
  visibility: "hidden" | "shown" | "former";
}

export interface UsageAnalyticsMembersResponse {
  members: UsageAnalyticsMemberRow[];
  pageInfo: PageInfo;
}

export interface WorkProviderModels {
  providerId: string;
  modelIds: string[];
}
export interface WorkModelOverride {
  providerId: string;
  modelId: string;
  enabled: boolean;
}
export interface EnterpriseWorkPolicy {
  schemaVersion: 1;
  enabled: boolean;
  personalInstallations: PersonalInstallationPolicy;
  managedCatalog: ManagedCatalogItem[];
  providerModels: WorkProviderModels[];
  forceAskMe: boolean;
  memoryAllowed: boolean;
  revision: number;
  /** Team-scope reads only: what this team may grant. Never sent to desktops. */
  delegation?: EffectiveWorkDelegation;
}
export type WorkPolicyInput = Omit<
  EnterpriseWorkPolicy,
  "schemaVersion" | "revision" | "delegation"
>;
export interface WorkPolicyOverrides {
  enabled: boolean | null;
  personalInstallations: {
    plugins: boolean | null;
    providers: boolean | null;
    skills: boolean | null;
  };
  managedCatalog: ManagedCatalogItem[];
  providerModels: WorkModelOverride[];
}
export interface WorkMemberPolicy {
  effective: EnterpriseWorkPolicy;
  inherited: EnterpriseWorkPolicy;
  organization: EnterpriseWorkPolicy;
  overrides: WorkPolicyOverrides;
  finalEffective?: EnterpriseWorkPolicy;
}
export interface DesktopWorkUsageSnapshotBatch
  extends DesktopUsageSnapshotBatch {
  /** Start of this enrolled Work collection source, never a personal-history timestamp. */
  enrolledAt: string;
}
export interface DesktopWorkAuditEvent {
  eventId: string;
  action:
    | "turn_started"
    | "turn_completed"
    | "turn_cancelled"
    | "turn_failed"
    | "tool_approved"
    | "tool_denied"
    | "policy_applied";
  occurredAt: string;
  policyRevision: number;
  providerId?: string;
  modelId?: string;
}

/** Shared company connection settings exposed in Work; Code model grants stay separate. */
export interface WorkProviderGateway {
  id: string;
  providerId: string;
  providerName: string;
  /** A key is encrypted and stored, without asserting a live upstream check. */
  credentialConfigured: true;
  requestsPerMinute: number;
  policyRevision: number;
  createdAt: string;
  updatedAt: string;
  /** Present when the provider's listing can safely enable all of its usable models. */
  modelSync?: { enabled: boolean; modelIds: string[] };
}

export interface WorkProviderGatewaysResponse {
  providerGateways: WorkProviderGateway[];
  revision: number;
}
export interface CreateWorkProviderGatewayInput {
  providerId: string;
  apiKey: string;
  requestsPerMinute: number;
  expectedRevision: number;
}
export interface UpdateWorkProviderGatewayInput {
  apiKey?: string;
  requestsPerMinute?: number;
  autoModels?: boolean;
  expectedRevision: number;
}

export * from "./authority.js";
export * from "./delegation.js";
export * from "./cloud.js";
export * from "./todos.js";
export * from "./cloud-projects.js";
export * from "./cloud-project-management.js";
export * from "./cloud-personal-projects.js";

export * from "./cloud-extensions.js";

export * from "./visuals/types.js";
export { parseVisual, visualText, slideContentValid, MAX_VISUAL_BYTES } from "./visuals/validate.js";
export { calculate, compileExpression } from "./visuals/arithmetic.js";
export { cloudVisualToolParameters } from "./visuals/tool.js";
export { isArtifactFile, parseArtifactFile, MAX_ARTIFACT_FILE_BYTES, artifactDisplayName, artifactLinkText, artifactTitlesFromTools, artifactVisualsFromTools } from "./visuals/artifact-file.js";
