"use client";

import type {
  EnterpriseWorkPolicy,
  PolicyCatalog,
} from "@lori-enterprise/contracts";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, Section, SettingsRow } from "@/components/ui/section";
import { Toggle } from "@/components/ui/toggle";
import { PolicySaveBar } from "@/components/policy/policy-save-bar";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { notifyWorkAccessChanged } from "@/hooks/use-work-availability";
import { ClientApiError } from "@/lib/client-api";
import { workApi as clientApi } from "@/lib/work-api";
import {
  WorkDecision,
  WorkExtensionAssignments,
} from "./work-extension-assignments";
import { WorkProviderAssignments } from "./work-provider-assignments";
import {
  draftOf,
  rebaseWorkDraft,
  validateWorkDraft,
} from "./work-policy-draft";
import type {
  WorkDraft,
  WorkMemberView,
  WorkMode,
  WorkOverrides,
} from "./work-policy-types";
export type {
  WorkMemberView,
  WorkMode,
  WorkOverrides,
} from "./work-policy-types";

type PolicyResponse = EnterpriseWorkPolicy | WorkMemberView;
type Recovery = {
  kind: "conflict" | "session" | "permission" | "rate" | "generic";
  message: string;
};
const scopeDescription: Record<WorkMode, string> = {
  organization:
    "Organization defaults apply to everyone. Teams can add grants; individual member rules decide final access. Approval and memory safeguards remain organization-wide.",
  team: "These grants add to organization and other team access. Turning a grant off removes only this team's contribution; it does not block another source.",
  member:
    "Individual member rules take precedence over organization and team grants. Inherit keeps combined access; Block explicitly removes access for this member.",
  "team-member":
    "These rules change this member's grants from this team. Removing a grant leaves organization and other team access in place; individual member rules still take precedence.",
  viewer:
    "Your administrator manages these settings. Contact them to request changes.",
};
function editable(result: PolicyResponse): WorkDraft | WorkOverrides {
  return "effective" in result ? result.overrides : draftOf(result);
}
function responsePolicy(result: PolicyResponse) {
  return "effective" in result ? result.organization : result;
}
function responseValid(
  value: unknown,
  override: boolean,
): value is PolicyResponse {
  const object = (entry: unknown): entry is Record<string, unknown> =>
    !!entry && typeof entry === "object" && !Array.isArray(entry);
  const flag = (entry: unknown, nullable = false) =>
    typeof entry === "boolean" || (nullable && entry === null);
  const id = (entry: unknown) =>
    typeof entry === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry);
  const model = (entry: unknown) =>
    typeof entry === "string" &&
    !!entry.trim() &&
    entry.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(entry);
  const personal = (entry: unknown, nullable = false) =>
    object(entry) &&
    ["plugins", "providers", "skills"].every((key) =>
      flag(entry[key], nullable),
    );
  const catalog = (entry: unknown) =>
    Array.isArray(entry) &&
    entry.every(
      (row) =>
        object(row) &&
        id(row.id) &&
        ["app", "plugin", "skill", "provider"].includes(String(row.type)) &&
        flag(row.enabled),
    );
  const policy = (entry: unknown) =>
    object(entry) &&
    entry.schemaVersion === 1 &&
    Number.isSafeInteger(entry.revision) &&
    Number(entry.revision) >= 0 &&
    flag(entry.enabled) &&
    flag(entry.forceAskMe) &&
    flag(entry.memoryAllowed) &&
    personal(entry.personalInstallations) &&
    catalog(entry.managedCatalog) &&
    Array.isArray(entry.providerModels) &&
    entry.providerModels.every(
      (row) =>
        object(row) &&
        id(row.providerId) &&
        Array.isArray(row.modelIds) &&
        row.modelIds.every(model),
    );
  if (!override) return policy(value);
  return (
    object(value) &&
    policy(value.organization) &&
    policy(value.inherited) &&
    policy(value.effective) &&
    (value.finalEffective === undefined || policy(value.finalEffective)) &&
    object(value.overrides) &&
    flag(value.overrides.enabled, true) &&
    personal(value.overrides.personalInstallations, true) &&
    catalog(value.overrides.managedCatalog) &&
    Array.isArray(value.overrides.providerModels) &&
    value.overrides.providerModels.length <= 2048 &&
    value.overrides.providerModels.every(
      (row) =>
        object(row) &&
        id(row.providerId) &&
        model(row.modelId) &&
        flag(row.enabled),
    )
  );
}
function sameMeaning(left: PolicyResponse, right: PolicyResponse) {
  const semantic = (value: PolicyResponse) =>
    JSON.stringify(value, (key, entry) =>
      key === "revision" ? undefined : entry,
    );
  return semantic(left) === semantic(right);
}
function Status({
  label,
  value,
  yes = "Allowed",
  no = "Blocked",
}: {
  label: string;
  value: boolean;
  yes?: string;
  no?: string;
}) {
  return (
    <Badge
      aria-label={`${label}: ${value ? yes : no}`}
      variant={value ? "success" : "secondary"}
    >
      {value ? yes : no}
    </Badge>
  );
}

export function WorkPolicyEditor({
  initialPolicy,
  initialMember,
  catalog,
  mode,
  endpoint,
  section = "access",
  canManageConnections = false,
  personalWorkspace = false,
}: {
  initialPolicy: EnterpriseWorkPolicy;
  initialMember?: WorkMemberView;
  catalog: PolicyCatalog;
  mode: WorkMode;
  endpoint: string;
  section?: "access" | "providers" | "extensions";
  canManageConnections?: boolean;
  personalWorkspace?: boolean;
}) {
  const operation = useRef(false);
  const [policy, setPolicy] = useState(initialPolicy);
  const [member, setMember] = useState(initialMember);
  const [draft, setDraft] = useState(() => draftOf(initialPolicy));
  const [overrides, setOverrides] = useState(initialMember?.overrides);
  const [saved, setSaved] = useState(() =>
    JSON.stringify(initialMember?.overrides ?? draftOf(initialPolicy)),
  );
  const [pending, setPending] = useState<"save" | "latest" | null>(null);
  const [error, setError] = useState<Recovery | null>(null);
  // Saving happens from the bar at the bottom; bring the explanation into view.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "start" });
  }, [error]);
  const [latest, setLatest] = useState<PolicyResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const readOnly = mode === "viewer";
  const isOverride = mode === "member" || mode === "team-member";
  const current = isOverride ? overrides : draft;
  const hasChanges = JSON.stringify(current) !== saved;
  const inherited = member?.inherited ?? policy;
  const effective = member?.finalEffective ?? member?.effective ?? policy;
  const coolingDown = now < retryAt;
  const blocked =
    !!latest ||
    error?.kind === "conflict" ||
    error?.kind === "session" ||
    error?.kind === "permission";
  const disabled = readOnly || !!pending || blocked;
  useUnsavedChanges(!readOnly && hasChanges);
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  function failure(reason: unknown) {
    const api = reason instanceof ClientApiError ? reason : null;
    if (
      api?.status === 409 ||
      api?.code === "policy_revision_conflict" ||
      api?.code === "invalid_response"
    )
      setError({
        kind: "conflict",
        message:
          "Work settings changed or their latest version could not be verified. Your draft is kept. Review the latest policy before saving.",
      });
    else if (api?.status === 401)
      setError({
        kind: "session",
        message:
          "Your session expired. Your draft is kept. Sign in again in another tab, then refresh access here.",
      });
    else if (api?.code === "delegation_not_approved")
      // The draft is valid but includes grants the organization has not approved for teams.
      setError({ kind: "generic", message: api.message });
    else if (api?.status === 403)
      setError({
        kind: "permission",
        message:
          "You no longer have permission to save these Work settings. Your draft is kept. Refresh access or ask an organization administrator.",
      });
    else if (api?.status === 429) {
      const seconds = Math.max(1, Math.min(api.retryAfterSeconds ?? 15, 3600));
      const time = Date.now();
      setNow(time);
      setRetryAt(time + seconds * 1000);
      setError({
        kind: "rate",
        message:
          "Too many requests. Your draft is kept. Wait before trying again.",
      });
    } else
      setError({
        kind: "generic",
        message:
          reason instanceof Error
            ? reason.message
            : "Work settings could not be saved. Check your connection and try again.",
      });
  }
  function accept(result: PolicyResponse, replaceDraft: boolean) {
    setPolicy(responsePolicy(result));
    if ("effective" in result) {
      setMember(result);
      if (replaceDraft) {
        setOverrides(result.overrides);
        setDraft(draftOf(result.effective));
      }
    } else if (replaceDraft) setDraft(draftOf(result));
    setSaved(JSON.stringify(editable(result)));
  }
  async function save() {
    if (operation.current || disabled || coolingDown || !hasChanges || !current)
      return;
    const invalid = validateWorkDraft(current);
    if (invalid) {
      setError({ kind: "generic", message: invalid });
      return;
    }
    operation.current = true;
    setPending("save");
    setError(null);
    setMessage(null);
    try {
      const result = await clientApi<PolicyResponse>(endpoint, {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: policy.revision,
          ...(isOverride ? { overrides } : { policy: draft }),
        }),
      });
      if (!responseValid(result, isOverride))
        throw new ClientApiError(
          "invalid_response",
          "The saved policy could not be verified.",
          200,
        );
      accept(result, true);
      setLatest(null);
      // Cloud Work follows this policy, so let open Work indicators re-read it now.
      notifyWorkAccessChanged();
      setMessage(
        "Work access saved. Cloud Work follows it now, and connected desktops will receive the updated policy.",
      );
    } catch (reason) {
      failure(reason);
    } finally {
      operation.current = false;
      setPending(null);
    }
  }
  async function reviewLatest(fromConnection = false) {
    if (operation.current || pending || coolingDown) return;
    operation.current = true;
    setPending("latest");
    setMessage(null);
    try {
      const result = await clientApi<PolicyResponse>(endpoint);
      if (!responseValid(result, isOverride))
        throw new ClientApiError(
          "invalid_response",
          "The latest Work policy could not be verified.",
          200,
        );
      if (
        !hasChanges ||
        (fromConnection &&
          JSON.stringify(editable(result)) === saved &&
          sameMeaning(member ?? policy, result))
      ) {
        accept(result, !hasChanges);
        setError(null);
        setLatest(null);
        setMessage(
          fromConnection
            ? "Company connection updated. Your Work assignments are preserved."
            : "Latest Work policy loaded.",
        );
      } else {
        setLatest(result);
        setError({
          kind: "conflict",
          message:
            "Review the latest policy below. Your unsaved edits are still kept.",
        });
      }
    } catch (reason) {
      failure(reason);
    } finally {
      operation.current = false;
      setPending(null);
    }
  }
  function rebase() {
    if (!latest || !current) return;
    const before = JSON.parse(saved) as WorkDraft | WorkOverrides;
    if (isOverride)
      setOverrides(
        rebaseWorkDraft(
          before as WorkOverrides,
          current as WorkOverrides,
          editable(latest) as WorkOverrides,
        ),
      );
    else
      setDraft(
        rebaseWorkDraft(
          before as WorkDraft,
          current as WorkDraft,
          editable(latest) as WorkDraft,
        ),
      );
    accept(latest, false);
    setLatest(null);
    setError(null);
    setMessage(
      "Your edits were applied to the latest policy. Review them before saving.",
    );
  }
  function changed() {
    setMessage(null);
    if (error?.kind === "generic") setError(null);
  }
  function boolControl(
    key: "enabled" | "providers" | "plugins" | "skills",
    label: string,
  ) {
    const inheritedValue =
      key === "enabled"
        ? inherited.enabled
        : inherited.personalInstallations[key];
    if (readOnly)
      return (
        <Status
          label={label}
          value={
            key === "enabled"
              ? effective.enabled
              : effective.personalInstallations[key]
          }
        />
      );
    if (isOverride && overrides)
      return (
        <WorkDecision
          mode={mode}
          label={label}
          disabled={disabled}
          inherited={inheritedValue}
          value={
            key === "enabled"
              ? overrides.enabled
              : overrides.personalInstallations[key]
          }
          onChange={(value) => {
            changed();
            setOverrides(
              (current) =>
                current &&
                (key === "enabled"
                  ? { ...current, enabled: value }
                  : {
                      ...current,
                      personalInstallations: {
                        ...current.personalInstallations,
                        [key]: value,
                      },
                    }),
            );
          }}
        />
      );
    return (
      <Toggle
        aria-label={label}
        disabled={disabled}
        checked={
          key === "enabled" ? draft.enabled : draft.personalInstallations[key]
        }
        onChange={() => {
          changed();
          setDraft((current) =>
            key === "enabled"
              ? { ...current, enabled: !current.enabled }
              : {
                  ...current,
                  personalInstallations: {
                    ...current.personalInstallations,
                    [key]: !current.personalInstallations[key],
                  },
                },
          );
        }}
      />
    );
  }
  function setCatalog(
    id: string,
    type: "plugin" | "skill" | "provider" | "app",
    enabled: boolean | null,
  ) {
    changed();
    if (mode === "team" && enabled === false) enabled = null;
    const change = (items: WorkDraft["managedCatalog"]) => [
      ...items.filter((item) => item.id !== id || item.type !== type),
      ...(enabled === null ? [] : [{ id, type, enabled }]),
    ];
    if (isOverride)
      setOverrides(
        (current) =>
          current && {
            ...current,
            managedCatalog: change(current.managedCatalog),
          },
      );
    else
      setDraft((current) => ({
        ...current,
        managedCatalog: change(current.managedCatalog),
      }));
  }
  function setModel(
    providerId: string,
    modelId: string,
    enabled: boolean | null,
  ) {
    changed();
    if (isOverride)
      setOverrides(
        (current) =>
          current && {
            ...current,
            providerModels: [
              ...current.providerModels.filter(
                (row) =>
                  row.providerId !== providerId || row.modelId !== modelId,
              ),
              ...(enabled === null ? [] : [{ providerId, modelId, enabled }]),
            ],
          },
      );
    else
      setDraft((current) => {
        const models =
          current.providerModels.find((row) => row.providerId === providerId)
            ?.modelIds ?? [];
        const next = enabled
          ? [...new Set([...models, modelId])]
          : models.filter((id) => id !== modelId);
        return {
          ...current,
          providerModels: [
            ...current.providerModels.filter(
              (row) => row.providerId !== providerId,
            ),
            { providerId, modelIds: next },
          ],
        };
      });
  }
  return (
    <div className="space-y-6" aria-busy={!!pending}>
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {scopeDescription[mode]}
      </p>
      {isOverride ? (
        <p className="text-sm text-muted-foreground">
          Current saved effective Work access:{" "}
          <strong className="text-foreground">
            {effective.enabled ? "Allowed" : "Blocked"}
          </strong>
          . Changes below apply after saving.
        </p>
      ) : null}
      {error ? (
        <Alert className="scroll-mt-20" ref={errorRef} variant="destructive">
          <div className="space-y-3">
            <p>{error.message}</p>
            <div className="flex flex-wrap items-center gap-2">
              {error.kind === "session" ? (
                <Button asChild variant="outline" size="sm">
                  <a href="/sign-in" target="_blank" rel="noreferrer">
                    Sign in again
                  </a>
                </Button>
              ) : null}
              {["conflict", "permission", "session"].includes(error.kind) ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!pending || coolingDown}
                  onClick={() => void reviewLatest()}
                >
                  {pending === "latest"
                    ? "Loading latest…"
                    : error.kind === "conflict"
                      ? "Review latest policy"
                      : "Refresh access"}
                </Button>
              ) : null}
              {error.kind === "rate" ? (
                <span role="status">
                  {coolingDown
                    ? `Try again in ${Math.ceil((retryAt - now) / 1000)} seconds.`
                    : "You can try saving again."}
                </span>
              ) : null}
              {error.kind === "generic" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!pending || !hasChanges}
                  onClick={() => void save()}
                >
                  Try saving again
                </Button>
              ) : null}
            </div>
          </div>
        </Alert>
      ) : null}
      {latest ? (
        <Section
          title="Review the latest policy"
          description="Your edits have not been saved. Applying them changes only decisions you edited; other recent changes are retained."
        >
          <Panel>
            <div className="space-y-4 p-4 sm:p-5">
              <p className="text-sm">
                Latest saved Work access:{" "}
                <strong>
                  {("effective" in latest ? latest.effective : latest).enabled
                    ? "Allowed"
                    : "Blocked"}
                </strong>{" "}
                · Revision {responsePolicy(latest).revision}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={rebase}>
                  Apply my edits to latest
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    accept(latest, true);
                    setLatest(null);
                    setError(null);
                    setMessage(
                      "Latest policy loaded. Your draft was discarded.",
                    );
                  }}
                >
                  Use latest and discard my draft
                </Button>
              </div>
            </div>
          </Panel>
        </Section>
      ) : null}
      {message ? <Alert variant="success">{message}</Alert> : null}
      {readOnly && section === "access" && !effective.enabled ? (
        <Alert variant="warning">
          Work is disabled. Saved settings below apply only when access is
          restored.
        </Alert>
      ) : null}
      {section === "access" ? (
        <>
          <Section
            title={readOnly ? "Your workspace" : "Work access"}
            description={
              readOnly
                ? "Your current access to Lori Work. Saved conversations and files are preserved if access is disabled."
                : "Control access to Work on desktops and in Enterprise Cloud. Enabling Work here makes Cloud Work available automatically. Saved conversations and files are preserved when access is disabled."
            }
          >
            <Panel>
              <SettingsRow
                label="Allow Work"
                description={
                  personalWorkspace
                    ? "Use Work's conversations and tools in this workspace."
                    : "Members can switch from Code to Work and use its conversations and tools."
                }
              >
                {boolControl("enabled", "Allow Work")}
              </SettingsRow>
            </Panel>
          </Section>
          {!personalWorkspace && <Section
            title={readOnly ? "What you can add" : "Member configuration"}
            description={
              readOnly
                ? "Your permission to add personal providers, plugins and bundled skills in Lori Work."
                : "Choose what members may connect outside the managed Work catalog."
            }
          >
            <Panel>
              <div className="divide-y divide-border">
                <SettingsRow
                  label="Member-added providers"
                  description="Personal API keys, custom endpoints and local models."
                >
                  {boolControl("providers", "Member-added providers")}
                </SettingsRow>
                <SettingsRow
                  label="Member-added plugins"
                  description="Additional plugins from the bundled Work catalog."
                >
                  {boolControl("plugins", "Member-added plugins")}
                </SettingsRow>
                <SettingsRow
                  label="Member-added skills"
                  description="Additional bundled guidance for Work tasks."
                >
                  {boolControl("skills", "Member-added skills")}
                </SettingsRow>
              </div>
            </Panel>
          </Section>}
          <Section
            title={personalWorkspace ? "Safeguards" : "Organization safeguards"}
            description={
              personalWorkspace
                ? "Control how Work acts on your behalf."
                : mode === "organization"
                  ? "These safeguards apply to every Work member and team."
                  : "Managed by your organization. Teams and individual member rules cannot change these safeguards."
            }
          >
            <Panel>
              <div className="divide-y divide-border">
                <SettingsRow
                  label="Require action approvals"
                  description="Require confirmation before commands, file changes and plugin writes, including when a member enabled automatic approval."
                >
                  {mode === "organization" ? (
                    <Toggle
                      aria-label="Require action approvals"
                      disabled={disabled}
                      checked={draft.forceAskMe}
                      onChange={() => {
                        changed();
                        setDraft((current) => ({
                          ...current,
                          forceAskMe: !current.forceAskMe,
                        }));
                      }}
                    />
                  ) : (
                    <Status
                      label="Require action approvals"
                      value={effective.forceAskMe}
                      yes="Required"
                      no="Member preference"
                    />
                  )}
                </SettingsRow>
                <SettingsRow
                  label="Allow memory"
                  description="Allow memory recall and learning. Turning this off preserves saved notes and personal preferences."
                >
                  {mode === "organization" ? (
                    <Toggle
                      aria-label="Allow memory"
                      disabled={disabled}
                      checked={draft.memoryAllowed}
                      onChange={() => {
                        changed();
                        setDraft((current) => ({
                          ...current,
                          memoryAllowed: !current.memoryAllowed,
                        }));
                      }}
                    />
                  ) : (
                    <Status
                      label="Allow memory"
                      value={effective.memoryAllowed}
                    />
                  )}
                </SettingsRow>
              </div>
            </Panel>
          </Section>
        </>
      ) : section === "extensions" ? (
        <WorkExtensionAssignments
          catalog={catalog}
          mode={mode}
          disabled={disabled}
          inherited={inherited}
          effective={effective}
          managedCatalog={
            isOverride
              ? (overrides?.managedCatalog ?? [])
              : draft.managedCatalog
          }
          onCatalog={setCatalog}
        />
      ) : (
        <WorkProviderAssignments
          catalog={catalog}
          mode={mode}
          readOnly={readOnly}
          disabled={disabled}
          inherited={inherited}
          effective={effective}
          managedCatalog={
            isOverride
              ? (overrides?.managedCatalog ?? [])
              : draft.managedCatalog
          }
          providerModels={draft.providerModels}
          modelOverrides={overrides?.providerModels}
          onCatalog={setCatalog}
          onModel={setModel}
          canManageConnections={canManageConnections}
          personalWorkspace={personalWorkspace}
          onConnectionsChanged={() => void reviewLatest(true)}
          onReviewLatest={() => void reviewLatest(true)}
        />
      )}
      {!readOnly ? (
        <PolicySaveBar
          stickyOnMobile={false}
          label="Work policy"
          description="Applies to Work only, including Cloud Work. Connected desktops receive changes after saving."
          hasChanges={hasChanges}
          saveDisabled={blocked || coolingDown || !!pending}
          pending={pending === "save"}
          onSave={() => void save()}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!hasChanges || !!pending}
            onClick={() => {
              if (isOverride) setOverrides(JSON.parse(saved) as WorkOverrides);
              else setDraft(JSON.parse(saved) as WorkDraft);
              setMessage("Your unsaved changes were discarded.");
            }}
          >
            Discard changes
          </Button>
        </PolicySaveBar>
      ) : null}
    </div>
  );
}
