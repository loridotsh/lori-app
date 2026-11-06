"use client";

import { useCallback, useEffect, useState } from "react";
import type { PersonalProjectCreationPolicy, PersonalProjectEffectivePermission } from "@lori-enterprise/contracts";
import { CheckIcon, UserIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { cloudApi, cloudError } from "@/lib/cloud-work-api";
import { getCreationPolicy, personalPath, saveCreationPolicy } from "@/lib/personal-projects-api";
import { cn } from "@/lib/utils";
import { PermissionCard, SaveBar, Section, SubjectList, SubjectPicker, sameKeys, subjectKey, type Directory, type Subject } from "./creation-parts";

const SOURCES: Record<PersonalProjectEffectivePermission["source"], string> = {
  organization_admin: "Allowed by the administrator default",
  everyone: "Allowed for everyone",
  member_grant: "Given to this member",
  team_grant: "Given through a team",
  blocked: "Blocked for this member",
  none: "Not given permission",
  unavailable: "Work is not available to this member",
};
const LIMIT_MAX = 1000;

const parseLimit = (text: string) => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return /^\d+$/.test(trimmed) && value >= 1 && value <= LIMIT_MAX ? value : undefined;
};
const asSubjects = (policy: PersonalProjectCreationPolicy): Subject[] => policy.grants.map(({ kind, subjectId }) => ({ kind, subjectId }));

function Choice({ checked, title, description, disabled, onSelect }: { checked: boolean; title: string; description: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", checked ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/50", disabled && "cursor-not-allowed opacity-60")}>
      <input type="radio" name="personal-creation-mode" className="mt-1" checked={checked} disabled={disabled} onChange={onSelect} />
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/** Who may create personal projects, who is blocked, and how many each member may keep. */
export function PersonalCreationPane({
  directory,
  onFailure,
  onDirtyChange,
  onBusyChange,
}: {
  directory: Directory;
  onFailure?: (failure: unknown) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [saved, setSaved] = useState<PersonalProjectCreationPolicy | null>(null);
  const [allowAll, setAllowAll] = useState(false);
  const [grants, setGrants] = useState<Subject[]>([]);
  const [blocked, setBlocked] = useState<Subject[]>([]);
  const [limit, setLimit] = useState("");
  const [probe, setProbe] = useState("");
  const [effective, setEffective] = useState<PersonalProjectEffectivePermission | null>(null);
  const [probeError, setProbeError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const adopt = useCallback((policy: PersonalProjectCreationPolicy) => {
    setSaved(policy);
    setAllowAll(policy.allowAll);
    setGrants(asSubjects(policy));
    setBlocked(policy.blockedMemberIds.map((subjectId) => ({ kind: "member" as const, subjectId })));
    setLimit(policy.maxPerMember === null ? "" : String(policy.maxPerMember));
  }, []);
  const load = useCallback(async () => {
    setError("");
    try {
      const policy = await getCreationPolicy();
      if (!policy || typeof policy.allowAll !== "boolean" || !Array.isArray(policy.grants) || !Array.isArray(policy.blockedMemberIds))
        throw new Error("Personal project settings returned an unreadable response. Try loading again.");
      adopt(policy);
    } catch (failure) {
      setError(cloudError(failure));
      onFailure?.(failure);
    }
  }, [adopt, onFailure]);
  useEffect(() => {
    void load();
  }, [load]);
  const parsed = parseLimit(limit);
  const dirty =
    !!saved &&
    (allowAll !== saved.allowAll ||
      !sameKeys(grants.map(subjectKey), asSubjects(saved).map(subjectKey)) ||
      !sameKeys(blocked.map((item) => item.subjectId), saved.blockedMemberIds) ||
      parsed !== saved.maxPerMember);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    setEffective(null);
    setProbeError("");
    if (!probe) return;
    let active = true;
    cloudApi<PersonalProjectEffectivePermission>(`${personalPath}/policy/effective?memberId=${encodeURIComponent(probe)}`)
      .then((value) => { if (active) setEffective(value); })
      .catch((failure) => { if (active) setProbeError(cloudError(failure)); });
    return () => { active = false; };
  }, [probe, saved?.revision]);
  const touch = () => setDone(false);
  const save = async () => {
    if (!saved || busy || !dirty || parsed === undefined) return;
    setBusy(true);
    setError("");
    try {
      adopt(await saveCreationPolicy({ expectedRevision: saved.revision, allowAll, grants, blockedMemberIds: blocked.map((item) => item.subjectId), maxPerMember: parsed }));
      setDone(true);
    } catch (failure) {
      setError(cloudError(failure));
      onFailure?.(failure);
    } finally {
      setBusy(false);
    }
  };
  const takenGrants = new Set(grants.map(subjectKey));
  const takenBlocks = new Set(blocked.map(subjectKey));
  const person = directory.members.find((member) => member.id === effective?.memberId)?.name ?? "This member";
  const loading = !saved && !error;
  const controls = !saved || busy;
  return (
    <PermissionCard title="Personal projects" icon={<UserIcon className="size-4" />} description="Private folders for a member's own conversations, instructions and reference files. Only the owner can open one; administrators cannot see its content. Changing these settings never affects projects that already exist.">
      {loading ? (
        <p role="status" className="py-4 text-xs text-muted-foreground">Loading personal project settings…</p>
      ) : (
        <>
          <Section title="Who can create personal projects">
            <div role="radiogroup" aria-label="Who can create personal projects" className="grid gap-2">
              <Choice checked={allowAll} disabled={controls} title="Everyone with Work access" description="Any member whose Work access is on can create personal projects." onSelect={() => { setAllowAll(true); touch(); }} />
              <Choice checked={!allowAll} disabled={controls} title="Only selected members and teams" description="Administrators plus the people and teams you add below." onSelect={() => { setAllowAll(false); touch(); }} />
            </div>
            {!allowAll && (
              <div className="space-y-3 pt-1">
                <SubjectPicker directory={directory} taken={takenGrants} label="Add a member or team for personal projects" placeholder="Choose a member or team" addLabel="Add" disabled={controls} onAdd={(subject) => { setGrants((current) => [...current, subject]); touch(); }} />
                <SubjectList items={grants} directory={directory} empty="No one has been given permission yet. Only administrators can create personal projects." disabled={busy} onRemove={(subject) => { setGrants((current) => current.filter((item) => subjectKey(item) !== subjectKey(subject))); touch(); }} />
              </div>
            )}
          </Section>
          <Section title="Blocked members" description="A block overrides everything above: the member cannot create personal projects even if everyone, or one of their teams, is allowed. Their existing projects stay available to them.">
            <SubjectPicker directory={directory} taken={takenBlocks} teams={false} label="Block a member" placeholder="Choose a member to block" addLabel="Block" disabled={controls} onAdd={(subject) => { setBlocked((current) => [...current, subject]); touch(); }} />
            <SubjectList items={blocked} directory={directory} removeLabel="Unblock" empty="No members are blocked." disabled={busy} onRemove={(subject) => { setBlocked((current) => current.filter((item) => item.subjectId !== subject.subjectId)); touch(); }} />
          </Section>
          <Section title="Projects kept per member" description={`Active, archived and recently deleted projects all count. Leave empty to use the default of ${saved?.defaultMaxPerMember ?? 100}.`}>
            <div className="grid max-w-48 gap-1.5">
              <Input aria-label="Projects kept per member" inputMode="numeric" aria-invalid={parsed === undefined || undefined} placeholder={`Default (${saved?.defaultMaxPerMember ?? 100})`} value={limit} disabled={controls} onChange={(event) => { setLimit(event.target.value.replace(/\D/g, "")); touch(); }} />
              {parsed === undefined && <p role="alert" className="text-xs text-destructive">Enter a whole number from 1 to {LIMIT_MAX}.</p>}
            </div>
          </Section>
          <Section title="Check a member" description={dirty ? "Shows what is saved today. Save your changes to include them." : "See whether a member can create personal projects, and why."}>
            <SearchSelect label="Member to check" placeholder="Choose a member" searchPlaceholder="Search name or email…" value={probe} onChange={setProbe} options={directory.members.map((member) => ({ value: member.id, label: member.name, description: member.email }))} />
            {probeError && <p role="alert" className="text-xs text-destructive">{probeError}</p>}
            {effective && (
              <p role="status" className="flex items-start gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
                {effective.allowed ? <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <XIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />}
                <span>
                  <span className="font-medium">{person} {effective.allowed ? "can create" : "cannot create"} personal projects.</span>{" "}
                  <span className="text-muted-foreground">{SOURCES[effective.source]}.</span>
                </span>
              </p>
            )}
          </Section>
        </>
      )}
      <SaveBar dirty={dirty} busy={busy} invalid={parsed === undefined} saved={done} error={error} onSave={() => void save()} onDiscard={() => { if (saved) adopt(saved); setDone(false); }} onReload={() => void load()} />
    </PermissionCard>
  );
}
