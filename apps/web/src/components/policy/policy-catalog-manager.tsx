"use client";
import { CatalogLogo } from "@/components/catalog-logo";

import type {
  MemberPolicy,
  OrganizationPolicy,
  PolicyCatalog,
  PolicyCatalogItemType,
  TeamMemberPolicy,
  TeamPolicy,
  TeamPolicyPreview,
} from "@lori-enterprise/contracts";
import { delegationApproves } from "@lori-enterprise/contracts";
import { BlocksIcon, CheckIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  catalogTypeLabel,
  initialCatalogDecisions,
  isAssignmentMode,
  isCatalogDirty,
  itemIdentity,
  managedPayload,
  type Decision,
  type PolicyMode,
} from "@/components/policy/policy-utils";
import { PolicySaveBar } from "@/components/policy/policy-save-bar";
import { TeamPolicyPreviewDialog } from "@/components/policy/team-policy-preview-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Panel, Section, SettingsRow } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { clientApi, ClientApiError } from "@/lib/client-api";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

interface PolicyCatalogManagerProps {
  catalog: PolicyCatalog;
  catalogType: PolicyCatalogItemType;
  initialMemberPolicy?: MemberPolicy;
  initialPolicy?: OrganizationPolicy;
  initialTeamMemberPolicy?: TeamMemberPolicy;
  initialTeamPolicy?: TeamPolicy;
  mode: PolicyMode;
  teamId?: string;
}

function sourcePolicyFor(
  props: PolicyCatalogManagerProps,
): OrganizationPolicy | TeamPolicy {
  if (props.mode === "organization" && props.initialPolicy) {
    return props.initialPolicy;
  }
  if (props.mode === "member" && props.initialMemberPolicy) {
    return props.initialMemberPolicy.inherited;
  }
  if (props.mode === "team" && props.initialTeamPolicy) {
    return props.initialTeamPolicy;
  }
  if (props.mode === "team-member" && props.initialTeamMemberPolicy) {
    return props.initialTeamMemberPolicy.team;
  }
  throw new Error(`Missing initial policy for ${props.mode} mode`);
}

function requireTeamId(teamId: string | undefined): string {
  if (!teamId) throw new Error("A team identifier is required.");
  return encodeURIComponent(teamId);
}

export function PolicyCatalogManager(props: PolicyCatalogManagerProps) {
  const {
    catalog,
    catalogType,
    initialMemberPolicy,
    initialTeamMemberPolicy,
    mode,
    teamId,
  } = props;
  const sourcePolicy = sourcePolicyFor(props);
  // Team scopes carry the organization's delegation ceiling so unapproved grants are explained.
  const delegation =
    mode === "team" || mode === "team-member"
      ? (sourcePolicy as TeamPolicy).delegation
      : undefined;
  const directAssignments = isAssignmentMode(mode);
  const managedRows =
    mode === "organization" || mode === "team"
      ? sourcePolicy.managedCatalog
      : mode === "member"
        ? initialMemberPolicy!.overrides.managedCatalog
        : initialTeamMemberPolicy!.overrides.managedCatalog;

  const [revision, setRevision] = useState(sourcePolicy.revision);
  const [catalogDecisions, setCatalogDecisions] = useState<
    Record<string, Decision>
  >(() => initialCatalogDecisions(mode, managedRows));
  const [savedCatalogDecisions, setSavedCatalogDecisions] = useState<
    Record<string, Decision>
  >(() => initialCatalogDecisions(mode, managedRows));
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<TeamPolicyPreview | null>(null);
  const hasChanges = useMemo(
    () =>
      isCatalogDirty(catalog, mode, catalogDecisions, savedCatalogDecisions),
    [catalog, catalogDecisions, mode, savedCatalogDecisions],
  );
  useUnsavedChanges(hasChanges && !pending);

  useEffect(() => {
    if (hasChanges) setMessage(null);
  }, [hasChanges]);

  const inheritedCatalog = useMemo(
    () =>
      new Map(
        sourcePolicy.managedCatalog.map((item) => [
          itemIdentity(item),
          item.enabled,
        ]),
      ),
    [sourcePolicy],
  );
  const connectedOrganizationProviderIds = useMemo(
    () => new Set(catalog.connectedOrganizationProviderIds ?? []),
    [catalog.connectedOrganizationProviderIds],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return catalog.items.filter(
      (item) =>
        item.type === catalogType &&
        (!needle ||
          item.name.toLocaleLowerCase().includes(needle) ||
          item.description.toLocaleLowerCase().includes(needle) ||
          item.id.toLocaleLowerCase().includes(needle)),
    );
  }, [catalog.items, catalogType, query]);

  const assignedCount = filtered.filter((item) => {
    const identity = itemIdentity(item);
    const current =
      catalogDecisions[identity] ?? (directAssignments ? "block" : "inherit");
    return directAssignments
      ? current === "allow"
      : current === "allow" ||
          (current === "inherit" && inheritedCatalog.get(identity));
  }).length;

  async function save() {
    const catalogSnapshot = catalogDecisions;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      if (mode === "organization") {
        const updated = await clientApi<OrganizationPolicy>(
          "/v1/admin/policy",
          {
            body: JSON.stringify({
              expectedRevision: revision,
              managedCatalog: managedPayload(catalog, catalogSnapshot, mode),
              personalInstallations: sourcePolicy.personalInstallations,
            }),
            method: "PATCH",
          },
        );
        setRevision(updated.revision);
      } else if (mode === "team") {
        const updated = await clientApi<TeamPolicy>(
          `/v1/teams/${requireTeamId(teamId)}/policy`,
          {
            body: JSON.stringify({
              expectedRevision: revision,
              managedCatalog: managedPayload(catalog, catalogSnapshot, mode),
              personalInstallations: sourcePolicy.personalInstallations,
            }),
            method: "PATCH",
          },
        );
        setRevision(updated.revision);
      } else if (mode === "member") {
        const memberId = initialMemberPolicy!.member.memberId;
        const updated = await clientApi<MemberPolicy>(
          `/v1/admin/members/${encodeURIComponent(memberId)}/policy`,
          {
            body: JSON.stringify({
              expectedRevision: revision,
              overrides: {
                managedCatalog: managedPayload(catalog, catalogSnapshot, mode),
                personalInstallations:
                  initialMemberPolicy!.overrides.personalInstallations,
              },
            }),
            method: "PATCH",
          },
        );
        setRevision(updated.organization.revision);
      } else {
        const memberId = initialTeamMemberPolicy!.member.memberId;
        const updated = await clientApi<TeamMemberPolicy>(
          `/v1/teams/${requireTeamId(teamId)}/members/${encodeURIComponent(memberId)}/policy`,
          {
            body: JSON.stringify({
              expectedRevision: revision,
              overrides: {
                managedCatalog: managedPayload(catalog, catalogSnapshot, mode),
                personalInstallations:
                  initialTeamMemberPolicy!.overrides.personalInstallations,
              },
            }),
            method: "PATCH",
          },
        );
        setRevision(updated.team.revision);
      }
      setSavedCatalogDecisions(catalogSnapshot);
      setMessage(`${catalogTypeLabel(catalogType)} assignments saved.`);
      setPreview(null);
    } catch (requestError) {
      setPreview(null);
      setError(
        requestError instanceof ClientApiError &&
          requestError.code === "policy_revision_conflict"
          ? "Access settings changed while this page was open. Reload before saving."
          : requestError instanceof Error
            ? requestError.message
            : "Assignments could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  async function reviewOrSave() {
    if (mode !== "team") {
      await save();
      return;
    }
    setPending(true);
    setError(null);
    try {
      const next = await clientApi<TeamPolicyPreview>(
        `/v1/teams/${requireTeamId(teamId)}/policy/preview`,
        {
          body: JSON.stringify({
            expectedRevision: revision,
            managedCatalog: managedPayload(catalog, catalogDecisions, mode),
            personalInstallations: sourcePolicy.personalInstallations,
          }),
          method: "POST",
        },
      );
      setPreview(next);
    } catch (requestError) {
      setError(
        requestError instanceof ClientApiError &&
          requestError.code === "policy_revision_conflict"
          ? "Access settings changed while this page was open. Reload the latest revision before reviewing."
          : requestError instanceof Error
            ? requestError.message
            : "The change preview could not be prepared.",
      );
    } finally {
      setPending(false);
    }
  }

  const assignmentDescription =
    mode === "organization"
      ? `Assign ${catalogTypeLabel(catalogType).toLowerCase()} to every member independently of personal installation policies.`
      : mode === "team"
        ? `Assign ${catalogTypeLabel(catalogType).toLowerCase()} to members of this team. Assignments combine with other team and organization grants.`
        : mode === "member"
          ? `Assign or block individual ${catalogTypeLabel(catalogType).toLowerCase()} for this member across the organization.`
          : `Adjust this team’s ${catalogTypeLabel(catalogType).toLowerCase()} contribution for the member.`;

  return (
    <div className="space-y-6 pb-24">
      <TeamPolicyPreviewDialog
        onClose={() => {
          if (!pending) setPreview(null);
        }}
        onConfirm={() => void save()}
        open={Boolean(preview)}
        pending={pending}
        preview={preview}
      />
      {error && (
        <Alert variant="destructive">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            {error.includes("Reload") ? (
              <Button
                onClick={() => window.location.reload()}
                size="sm"
                type="button"
                variant="outline"
              >
                Reload latest
              </Button>
            ) : null}
          </div>
        </Alert>
      )}
      {message && <Alert variant="success">{message}</Alert>}
      {mode === "organization" && (
        <Alert>
          Removing an assignment disables the organization-provisioned copy in
          coding tools without deleting local files. If personal{" "}
          {catalogTypeLabel(catalogType).toLowerCase()} are allowed, the member
          may explicitly enable the retained copy again. Use a member-level
          Block when one person must not re-enable it.
        </Alert>
      )}
      {mode === "team" && (
        <Alert>
          Team grants are additive. Removing the final managed grant disables
          its coding-tool integration without deleting local files. Access from
          the organization, another team, a member override, or a separately
          enabled personal install still applies.
        </Alert>
      )}
      {catalogType === "provider" && (
        <Alert>
          A provider assignment controls who may use it. A{" "}
          <strong>Connected</strong> provider is configured with a company-owned
          key in Lori Enterprise; a provider without that status will not add a
          company-managed configuration to members’ devices.
        </Alert>
      )}

      <Section
        action={
          <Badge variant="outline">
            {assignedCount} of {filtered.length} assigned
          </Badge>
        }
        description={assignmentDescription}
        title={`Managed ${catalogTypeLabel(catalogType).toLowerCase()}`}
      >
        <div className="relative mb-4 max-w-sm">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={`Search ${catalogType}`}
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${catalogTypeLabel(catalogType).toLowerCase()}…`}
            value={query}
          />
        </div>

        <Panel>
          {filtered.length === 0 ? (
            <EmptyState
              description="Try a different search term or check another catalog section."
              icon={BlocksIcon}
              title={`No ${catalogTypeLabel(catalogType).toLowerCase()} found`}
            />
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((item) => {
                const identity = itemIdentity(item);
                const current =
                  catalogDecisions[identity] ??
                  (directAssignments ? "block" : "inherit");
                const inherited = inheritedCatalog.get(identity) ?? false;
                const hint =
                  !directAssignments && current === "inherit"
                    ? `${mode === "member" ? "Inherited assignment" : "Team assignment"}: ${
                        inherited ? "Assigned" : "Not assigned"
                      }`
                    : undefined;

                return (
                  <SettingsRow
                    description={item.description || item.id}
                    hint={hint}
                    key={identity}
                    icon={<CatalogLogo id={item.id} type={item.type} />}
                    label={item.name}
                  >
                    <div className="flex items-center gap-2">
                      {item.featured && (
                        <Badge
                          className="hidden sm:inline-flex"
                          variant="secondary"
                        >
                          Featured
                        </Badge>
                      )}
                      {item.requiresAuth && (
                        <Badge
                          className="hidden sm:inline-flex"
                          variant="outline"
                        >
                          Credentials
                        </Badge>
                      )}
                      {delegation &&
                        !delegationApproves(delegation, item) && (
                          <Badge
                            title="Outside what the organization approved for team administrators. A team grant of it does not take effect; an organization admin's grant approves it."
                            variant="warning"
                          >
                            Not approved for teams
                          </Badge>
                        )}
                      {catalogType === "provider" && (
                        <Badge
                          className="inline-flex"
                          variant={
                            connectedOrganizationProviderIds.has(item.id)
                              ? "success"
                              : "warning"
                          }
                        >
                          {connectedOrganizationProviderIds.has(item.id)
                            ? "Connected"
                            : "Not connected"}
                        </Badge>
                      )}
                      {!directAssignments ? (
                        <SelectWrapper className="w-36">
                          <Select
                            aria-label={`${item.name} decision`}
                            className="sm:text-xs"
                            onChange={(event) =>
                              setCatalogDecisions((values) => ({
                                ...values,
                                [identity]: event.target.value as Decision,
                              }))
                            }
                            value={current}
                          >
                            <option value="inherit">Inherit</option>
                            <option value="allow">Allow</option>
                            <option value="block">
                              {mode === "member" ? "Block" : "Remove grant"}
                            </option>
                          </Select>
                        </SelectWrapper>
                      ) : (
                        <Button
                          aria-label={`${current === "allow" ? "Remove" : "Assign"} ${item.name}`}
                          aria-pressed={current === "allow"}
                          className="min-w-28"
                          onClick={() =>
                            setCatalogDecisions((values) => ({
                              ...values,
                              [identity]:
                                current === "allow" ? "block" : "allow",
                            }))
                          }
                          size="sm"
                          type="button"
                          variant={current === "allow" ? "default" : "outline"}
                        >
                          {current === "allow" ? (
                            <>
                              <CheckIcon className="size-3.5" />
                              Assigned
                            </>
                          ) : (
                            "Assign"
                          )}
                        </Button>
                      )}
                    </div>
                  </SettingsRow>
                );
              })}
            </div>
          )}
        </Panel>
      </Section>

      <PolicySaveBar
        description="Changes take effect on the next desktop sync, or immediately after Refresh policy in Lori Settings."
        hasChanges={hasChanges}
        label={
          mode === "organization"
            ? "Organization catalog assignments"
            : mode === "team"
              ? "Team catalog assignments"
              : mode === "member"
                ? "Member catalog overrides"
                : "Team member catalog overrides"
        }
        onSave={() => void reviewOrSave()}
        pending={pending}
        saveLabel={mode === "team" ? "Review changes" : "Save changes"}
      />
    </div>
  );
}
