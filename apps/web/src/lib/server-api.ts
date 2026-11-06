import "server-only";

import type {
  AuditEventsResponse,
  DevicesResponse,
  EligibleTeamMembersResponse,
  JoinPreview,
  MemberPolicy,
  OrganizationPolicy,
  OrganizationProviderGatewayCatalogResponse,
  OrganizationProviderGatewaysResponse,
  PolicyCatalog,
  PeopleResponse,
  SetupStatus,
  Team,
  TeamMemberPolicy,
  TeamMembersResponse,
  TeamPolicy,
  TeamsResponse,
  Viewer,
  ProjectCapabilities,
  UsageAnalyticsResponse,
  EnterpriseWorkPolicy,
  WorkMemberPolicy,
  WorkspacesResponse,
} from "@lori-enterprise/contracts";
import { headers } from "next/headers";

const apiUrl =
  process.env.LORI_API_INTERNAL_URL ?? "http://127.0.0.1:4000";

async function serverApi<T>(
  path: string,
  options: { allow?: number[]; cookie?: boolean } = {},
): Promise<{ data: T | null; status: number }> {
  const requestHeaders = new Headers();
  if (options.cookie) {
    const cookie = (await headers()).get("cookie");
    if (cookie) {
      requestHeaders.set("cookie", cookie);
    }
  }

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      cache: "no-store",
      headers: requestHeaders,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { data: null, status: response.status };
    }
    return { data: (await response.json()) as T, status: response.status };
  } catch {
    return { data: null, status: 503 };
  }
}

export async function getWorkPolicy(path = "/v1/work/policy") {
  return serverApi<EnterpriseWorkPolicy | WorkMemberPolicy>(path, { cookie: true });
}

export async function getWorkCatalog() {
  return serverApi<PolicyCatalog>("/v1/work/catalog", { cookie: true });
}

export async function getProjectCapabilities() {
  return serverApi<ProjectCapabilities>("/v1/work/cloud/projects/capabilities", { cookie: true });
}

export async function getSetupStatus(): Promise<SetupStatus | null> {
  return (await serverApi<SetupStatus>("/v1/setup/status")).data;
}

export async function getViewer(): Promise<{
  status: number;
  viewer: Viewer | null;
}> {
  const result = await serverApi<Viewer>("/v1/me", { cookie: true });
  return { status: result.status, viewer: result.data };
}

export async function getWorkspaces(): Promise<{
  status: number;
  workspaces: WorkspacesResponse | null;
}> {
  const result = await serverApi<WorkspacesResponse>("/v1/workspaces", {
    cookie: true,
  });
  return { status: result.status, workspaces: result.data };
}

export async function getUsageAnalytics(
  admin: boolean,
  from: string,
  to: string,
  product: "code" | "work" = "code",
): Promise<{ analytics: UsageAnalyticsResponse | null; status: number }> {
  const params = new URLSearchParams({ from, to });
  if (product === "work") params.set("product", product);
  const result = await serverApi<UsageAnalyticsResponse>(
    `${admin ? "/v1/admin/usage" : "/v1/usage"}?${params.toString()}`,
    { cookie: true },
  );
  return { analytics: result.data, status: result.status };
}

export async function getJoinPreview(token: string): Promise<{
  invitation: JoinPreview | null;
  status: number;
}> {
  const result = await serverApi<JoinPreview>(
    `/v1/join/${encodeURIComponent(token)}`,
  );
  return { invitation: result.data, status: result.status };
}

export async function getPeople(): Promise<{
  people: PeopleResponse | null;
  status: number;
}> {
  const result = await serverApi<PeopleResponse>("/v1/admin/people", {
    cookie: true,
  });
  return { people: result.data, status: result.status };
}

export async function getAuditEvents({
  action = "",
  offset = 0,
  query = "",
}: {
  action?: string;
  offset?: number;
  query?: string;
} = {}): Promise<{ audit: AuditEventsResponse | null; status: number }> {
  const params = new URLSearchParams({ limit: "50", offset: String(offset) });
  if (query) params.set("q", query);
  if (action) params.set("action", action);
  const result = await serverApi<AuditEventsResponse>(
    `/v1/admin/audit-events?${params.toString()}`,
    { cookie: true },
  );
  return { audit: result.data, status: result.status };
}

export async function getPolicy(): Promise<{
  policy: OrganizationPolicy | null;
  status: number;
}> {
  const result = await serverApi<OrganizationPolicy>("/v1/policy", {
    cookie: true,
  });
  return { policy: result.data, status: result.status };
}

export async function getOrganizationPolicy(): Promise<{
  policy: OrganizationPolicy | null;
  status: number;
}> {
  const result = await serverApi<OrganizationPolicy>("/v1/admin/policy", {
    cookie: true,
  });
  return { policy: result.data, status: result.status };
}

export async function getOrganizationProviderGateways(): Promise<{
  gateways: OrganizationProviderGatewaysResponse | null;
  status: number;
}> {
  const result = await serverApi<OrganizationProviderGatewaysResponse>(
    "/v1/admin/provider-gateways",
    { cookie: true },
  );
  return { gateways: result.data, status: result.status };
}

export async function getOrganizationProviderGatewayCatalog(): Promise<{
  catalog: OrganizationProviderGatewayCatalogResponse | null;
  status: number;
}> {
  const result = await serverApi<OrganizationProviderGatewayCatalogResponse>(
    "/v1/admin/provider-gateways/catalog",
    { cookie: true },
  );
  return { catalog: result.data, status: result.status };
}

export async function getPolicyCatalog(): Promise<{
  catalog: PolicyCatalog | null;
  status: number;
}> {
  const result = await serverApi<PolicyCatalog>("/v1/admin/catalog", {
    cookie: true,
  });
  return { catalog: result.data, status: result.status };
}

export async function getMemberPolicy(
  memberId: string,
): Promise<{ policy: MemberPolicy | null; status: number }> {
  const result = await serverApi<MemberPolicy>(
    `/v1/admin/members/${encodeURIComponent(memberId)}/policy`,
    { cookie: true },
  );
  return { policy: result.data, status: result.status };
}

export async function getDevices(
  organizationWide = false,
): Promise<{ devices: DevicesResponse | null; status: number }> {
  const result = await serverApi<DevicesResponse>(
    organizationWide ? "/v1/admin/devices" : "/v1/devices",
    { cookie: true },
  );
  return { devices: result.data, status: result.status };
}

export async function getTeams(): Promise<{
  status: number;
  teams: TeamsResponse | null;
}> {
  const result = await serverApi<TeamsResponse>("/v1/admin/teams", {
    cookie: true,
  });
  return { status: result.status, teams: result.data };
}

export async function getTeam(
  identifier: string,
): Promise<{ status: number; team: Team | null }> {
  const result = await serverApi<Team>(
    `/v1/teams/${encodeURIComponent(identifier)}`,
    { cookie: true },
  );
  return { status: result.status, team: result.data };
}

export async function getTeamMembers(
  teamId: string,
): Promise<{ members: TeamMembersResponse | null; status: number }> {
  const result = await serverApi<TeamMembersResponse>(
    `/v1/teams/${encodeURIComponent(teamId)}/members`,
    { cookie: true },
  );
  return { members: result.data, status: result.status };
}

export async function getEligibleTeamMembers(
  teamId: string,
): Promise<{ members: EligibleTeamMembersResponse | null; status: number }> {
  const result = await serverApi<EligibleTeamMembersResponse>(
    `/v1/teams/${encodeURIComponent(teamId)}/eligible-members`,
    { cookie: true },
  );
  return { members: result.data, status: result.status };
}

export async function getTeamPolicy(
  teamId: string,
): Promise<{ policy: TeamPolicy | null; status: number }> {
  const result = await serverApi<TeamPolicy>(
    `/v1/teams/${encodeURIComponent(teamId)}/policy`,
    { cookie: true },
  );
  return { policy: result.data, status: result.status };
}

export async function getTeamMemberPolicy(
  teamId: string,
  memberId: string,
): Promise<{ policy: TeamMemberPolicy | null; status: number }> {
  const result = await serverApi<TeamMemberPolicy>(
    `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}/policy`,
    { cookie: true },
  );
  return { policy: result.data, status: result.status };
}

/** Whether Cloud Work is available to the signed-in member; `enabled` is null when it could not be determined. */
export async function getCloudAvailability(): Promise<{
  enabled: boolean | null;
  status: number;
}> {
  const result = await serverApi<{ enabled?: unknown }>(
    "/v1/work/cloud/capabilities",
    { cookie: true },
  );
  return {
    enabled:
      typeof result.data?.enabled === "boolean" ? result.data.enabled : null,
    status: result.status,
  };
}
