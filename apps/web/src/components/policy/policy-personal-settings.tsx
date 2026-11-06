"use client";

import type {
  MemberPolicy,
  OrganizationPolicy,
  TeamMemberPolicy,
  TeamPolicy,
  TeamPolicyPreview,
} from "@lori-enterprise/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PolicySaveBar } from "@/components/policy/policy-save-bar";
import { TeamPolicyPreviewDialog } from "@/components/policy/team-policy-preview-dialog";
import {
  decision,
  decisionValue,
  hasMemberPolicyOverrides,
  initialCatalogDecisions,
  isAssignmentMode,
  isPersonalDirty,
  personalSections,
  type Decision,
  type PersonalKey,
  type PolicyMode,
} from "@/components/policy/policy-utils";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, Section, SettingsRow } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { clientApi, ClientApiError } from "@/lib/client-api";
import { Dialog } from "@/components/ui/dialog";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

const individualDescriptions = {
  plugins: "Install and configure marketplace apps and MCP plugins.",
  providers: "Add cloud or local model providers with your own credentials.",
  skills: "Install and activate skills.",
} as const;

interface PolicyPersonalSettingsProps {
  initialMemberPolicy?: MemberPolicy;
  initialPolicy?: OrganizationPolicy;
  initialTeamMemberPolicy?: TeamMemberPolicy;
  initialTeamPolicy?: TeamPolicy;
  mode: PolicyMode;
  /** An individual's own workspace: there are no members to set rules for. */
  personalWorkspace?: boolean;
  teamId?: string;
}

function sourcePolicyFor({
  initialMemberPolicy,
  initialPolicy,
  initialTeamMemberPolicy,
  initialTeamPolicy,
  mode,
}: PolicyPersonalSettingsProps): OrganizationPolicy | TeamPolicy {
  if (mode === "organization" && initialPolicy) return initialPolicy;
  if (mode === "member" && initialMemberPolicy) {
    return initialMemberPolicy.inherited;
  }
  if (mode === "team" && initialTeamPolicy) return initialTeamPolicy;
  if (mode === "team-member" && initialTeamMemberPolicy) {
    return initialTeamMemberPolicy.team;
  }
  throw new Error(`Missing initial policy for ${mode} mode`);
}

function requireTeamId(teamId: string | undefined): string {
  if (!teamId) throw new Error("A team identifier is required.");
  return encodeURIComponent(teamId);
}

export function PolicyPersonalSettings(
  props: PolicyPersonalSettingsProps,
) {
  const {
    initialMemberPolicy,
    initialTeamMemberPolicy,
    initialTeamPolicy,
    mode,
    personalWorkspace = false,
    teamId,
  } = props;
  const sourcePolicy = sourcePolicyFor(props);
  const overridePolicy =
    mode === "member"
      ? initialMemberPolicy
      : mode === "team-member"
        ? initialTeamMemberPolicy
        : undefined;
  const directSettings = isAssignmentMode(mode);

  const [revision, setRevision] = useState(sourcePolicy.revision);
  const initialPersonal = useMemo<Record<PersonalKey, Decision>>(() => {
    const values = directSettings
      ? sourcePolicy.personalInstallations
      : overridePolicy!.overrides.personalInstallations;
    return {
      plugins: decision(values.plugins),
      providers: decision(values.providers),
      skills: decision(values.skills),
    };
  }, [directSettings, overridePolicy, sourcePolicy.personalInstallations]);

  const [personal, setPersonal] =
    useState<Record<PersonalKey, Decision>>(initialPersonal);
  const [savedPersonal, setSavedPersonal] =
    useState<Record<PersonalKey, Decision>>(initialPersonal);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<TeamPolicyPreview | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const hasChanges = useMemo(
    () => isPersonalDirty(personal, savedPersonal),
    [personal, savedPersonal],
  );
  const canResetOverrides = useMemo(() => {
    if (directSettings || pending || !overridePolicy) return false;
    const catalogOverrides = initialCatalogDecisions(
      mode,
      overridePolicy.overrides.managedCatalog,
    );
    return hasMemberPolicyOverrides(personal, catalogOverrides);
  }, [directSettings, mode, overridePolicy, pending, personal]);
  useUnsavedChanges(hasChanges && !pending);

  useEffect(() => {
    if (hasChanges) setMessage(null);
  }, [hasChanges]);

  async function save() {
    const personalSnapshot = personal;
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
              managedCatalog: sourcePolicy.managedCatalog,
              personalInstallations: {
                plugins: personalSnapshot.plugins === "allow",
                providers: personalSnapshot.providers === "allow",
                skills: personalSnapshot.skills === "allow",
              },
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
              managedCatalog: sourcePolicy.managedCatalog,
              personalInstallations: {
                plugins: personalSnapshot.plugins === "allow",
                providers: personalSnapshot.providers === "allow",
                skills: personalSnapshot.skills === "allow",
              },
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
                managedCatalog: initialMemberPolicy!.overrides.managedCatalog,
                personalInstallations: {
                  plugins: decisionValue(personalSnapshot.plugins),
                  providers: decisionValue(personalSnapshot.providers),
                  skills: decisionValue(personalSnapshot.skills),
                },
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
                managedCatalog:
                  initialTeamMemberPolicy!.overrides.managedCatalog,
                personalInstallations: {
                  plugins: decisionValue(personalSnapshot.plugins),
                  providers: decisionValue(personalSnapshot.providers),
                  skills: decisionValue(personalSnapshot.skills),
                },
              },
            }),
            method: "PATCH",
          },
        );
        setRevision(updated.team.revision);
      }
      setSavedPersonal(personalSnapshot);
      setMessage("Personal access settings saved.");
      setPreview(null);
    } catch (requestError) {
      setPreview(null);
      setError(
        requestError instanceof ClientApiError &&
          requestError.code === "policy_revision_conflict"
          ? "Access settings changed while this page was open. Reload before saving."
          : requestError instanceof Error
            ? requestError.message
            : "Settings could not be saved.",
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
            managedCatalog: sourcePolicy.managedCatalog,
            personalInstallations: {
              plugins: personal.plugins === "allow",
              providers: personal.providers === "allow",
              skills: personal.skills === "allow",
            },
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

  async function resetOverrides() {
    if (
      directSettings ||
      !overridePolicy ||
      !resetOpen
    ) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "member") {
        const memberId = initialMemberPolicy!.member.memberId;
        const updated = await clientApi<MemberPolicy>(
          `/v1/admin/members/${encodeURIComponent(memberId)}/policy?expectedRevision=${revision}`,
          { method: "DELETE" },
        );
        setRevision(updated.organization.revision);
      } else {
        const memberId = initialTeamMemberPolicy!.member.memberId;
        const updated = await clientApi<TeamMemberPolicy>(
          `/v1/teams/${requireTeamId(teamId)}/members/${encodeURIComponent(memberId)}/policy?expectedRevision=${revision}`,
          { method: "DELETE" },
        );
        setRevision(updated.team.revision);
      }
      const resetPersonal = {
        plugins: "inherit" as const,
        providers: "inherit" as const,
        skills: "inherit" as const,
      };
      setPersonal(resetPersonal);
      setSavedPersonal(resetPersonal);
      setMessage("All overrides were removed.");
      setResetOpen(false);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Overrides could not be reset.",
      );
    } finally {
      setPending(false);
    }
  }

  const sectionDescription = personalWorkspace
    ? "Choose what you can add to Lori yourself. Local files are preserved if you turn something off."
    : mode === "organization"
      ? "Choose what members may configure outside the organization catalog. Local files are preserved when access is blocked."
      : mode === "team"
        ? "Team access is additive. Turning a setting off removes this team’s grant; it does not block access granted by the organization, another team, or a member override."
        : mode === "member"
          ? "Override personal access for this member. Inherited decisions track organization and team grants automatically."
          : "Adjust this team’s contribution for the member. Other teams and organization grants remain independent.";

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
      <Dialog
        description={
          mode === "member"
            ? "Remove every override and return this member to inherited organization and team access?"
            : "Remove every team-specific override for this member?"
        }
        onClose={() => {
          if (!pending) setResetOpen(false);
        }}
        open={resetOpen}
        title="Reset all overrides?"
      >
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button disabled={pending} onClick={() => setResetOpen(false)} type="button" variant="outline">
            Keep overrides
          </Button>
          <Button disabled={pending} onClick={() => void resetOverrides()} type="button" variant="destructive">
            Reset overrides
          </Button>
        </div>
      </Dialog>
      {error && (
        <Alert variant="destructive">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            {error.includes("Reload") && (
              <Button onClick={() => window.location.reload()} size="sm" type="button" variant="outline">
                Reload latest
              </Button>
            )}
          </div>
        </Alert>
      )}
      {message && <Alert variant="success">{message}</Alert>}

      <Section
        action={
          <Badge className="font-mono" variant="outline">
            Revision {revision}
          </Badge>
        }
        description={sectionDescription}
        title={personalWorkspace ? "What you can add" : "Personal configuration"}
      >
        <Panel>
          <div className="divide-y divide-border">
            {personalSections.map(({ description, key, label }) => {
              const inherited = sourcePolicy.personalInstallations[key];
              const current = personal[key];
              const hint =
                mode === "team"
                  ? current === "allow"
                    ? "Effective source: this team grants access."
                    : initialTeamPolicy!.organizationPersonalInstallations[key]
                      ? "Effective source: the organization still grants access."
                      : "This team does not grant access. Another team or member override may still grant it."
                  : !directSettings && current === "inherit"
                  ? `${mode === "member" ? "Inherited access" : "Team setting"}: ${
                      inherited ? "Allowed" : "Not granted"
                    }`
                  : undefined;

              return (
                <SettingsRow
                  description={personalWorkspace ? individualDescriptions[key] : description}
                  hint={hint}
                  key={key}
                  label={label}
                >
                  {!directSettings ? (
                    <SelectWrapper className="w-36">
                      <Select
                        aria-label={`${label} decision`}
                        className="sm:text-xs"
                        onChange={(event) =>
                          setPersonal((values) => ({
                            ...values,
                            [key]: event.target.value as Decision,
                          }))
                        }
                        value={current}
                      >
                        <option value="inherit">Inherit</option>
                        <option value="allow">Allow</option>
                        <option value="block">Remove grant</option>
                      </Select>
                    </SelectWrapper>
                  ) : (
                    <Toggle
                      aria-label={`${current === "allow" ? "Disable" : "Enable"} ${label}`}
                      checked={current === "allow"}
                      onChange={() =>
                        setPersonal((values) => ({
                          ...values,
                          [key]: current === "allow" ? "block" : "allow",
                        }))
                      }
                    />
                  )}
                </SettingsRow>
              );
            })}
          </div>
        </Panel>
      </Section>

      <PolicySaveBar
        description="Changes take effect on the next desktop sync, or immediately after Refresh policy in Lori Settings."
        hasChanges={hasChanges}
        label={
          personalWorkspace
            ? "Your settings"
            : mode === "organization"
            ? "Organization defaults"
            : mode === "team"
              ? "Team access grants"
              : mode === "member"
                ? "Member personal access overrides"
                : "Team member access overrides"
        }
        onSave={() => void reviewOrSave()}
        pending={pending}
        saveLabel={mode === "team" ? "Review changes" : "Save changes"}
      >
        {!directSettings && (
          <Button
            disabled={!canResetOverrides}
            onClick={() => setResetOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <RotateCcwIcon className="size-3.5" />
            Reset all overrides
          </Button>
        )}
      </PolicySaveBar>
    </div>
  );
}
