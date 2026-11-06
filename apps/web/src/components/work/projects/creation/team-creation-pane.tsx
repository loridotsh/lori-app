"use client";

import { useCallback, useEffect, useState } from "react";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { UsersIcon } from "lucide-react";
import { PermissionCard, SaveBar, SubjectList, SubjectPicker, sameKeys, subjectKey, type Directory, type Subject } from "./creation-parts";

interface TeamPolicy {
  revision: number;
  grants: Subject[];
}

/** Who may create team projects. Administrators always can; the list only adds people and teams. */
export function TeamCreationPane({
  directory,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  directory: Directory;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [saved, setSaved] = useState<TeamPolicy | null>(null);
  const [grants, setGrants] = useState<Subject[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const adopt = useCallback((policy: TeamPolicy) => {
    const normalized = policy.grants.map(({ kind, subjectId }) => ({ kind, subjectId }));
    setSaved({ revision: policy.revision, grants: normalized });
    setGrants(normalized);
  }, []);
  const load = useCallback(async () => {
    setError("");
    try {
      const policy = await cloudApi<TeamPolicy>("/projects/creation-policy");
      if (!policy || typeof policy.revision !== "number" || !Array.isArray(policy.grants)) throw new Error("Team project settings returned an unreadable response. Try loading again.");
      adopt(policy);
    } catch (failure) {
      setError(cloudError(failure));
    }
  }, [adopt]);
  useEffect(() => {
    void load();
  }, [load]);
  const dirty = !!saved && !sameKeys(grants.map(subjectKey), saved.grants.map(subjectKey));
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const taken = new Set(grants.map(subjectKey));
  const save = async () => {
    if (!saved || busy || !dirty) return;
    setBusy(true);
    setError("");
    try {
      adopt(await cloudApi<TeamPolicy>("/projects/creation-policy", cloudMutation({ expectedRevision: saved.revision, grants }, "PUT")));
      setDone(true);
      onSaved();
    } catch (failure) {
      setError(cloudError(failure));
    } finally {
      setBusy(false);
    }
  };
  const loading = !saved && !error;
  return (
    <PermissionCard title="Team projects" icon={<UsersIcon className="size-4" />} description="Shared workspaces: everyone you give access shares its chats, files and memory. Administrators can always create them. Removing someone stops new projects, not the ones they already manage.">
      <div className="space-y-3">
        {loading ? (
          <p role="status" className="text-xs text-muted-foreground">Loading team project settings…</p>
        ) : (
          <>
            <SubjectPicker directory={directory} taken={taken} label="Add a member or team for team projects" placeholder="Choose a member or team" addLabel="Add" disabled={!saved || busy} onAdd={(subject) => { setGrants((current) => [...current, subject]); setDone(false); }} />
            <SubjectList items={grants} directory={directory} empty="No one has been given permission yet. Only administrators can create team projects." disabled={busy} onRemove={(subject) => { setGrants((current) => current.filter((item) => subjectKey(item) !== subjectKey(subject))); setDone(false); }} />
          </>
        )}
      </div>
      <SaveBar dirty={dirty} busy={busy} saved={done} error={error} onSave={() => void save()} onDiscard={() => { if (saved) setGrants(saved.grants); setDone(false); }} onReload={() => void load()} />
    </PermissionCard>
  );
}
