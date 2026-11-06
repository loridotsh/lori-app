"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cloudApi, cloudError } from "@/lib/cloud-work-api";
import { readableDirectory, type Directory } from "./creation-parts";
import { PersonalCreationPane } from "./personal-creation-pane";
import { TeamCreationPane } from "./team-creation-pane";

/** Who may create team projects and personal projects, managed together. */
export function CreationAccess({
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [teamAvailable, setTeamAvailable] = useState(false);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState({ team: false, personal: false });
  const [busy, setBusy] = useState({ team: false, personal: false });
  const load = useCallback(async () => {
    setError("");
    try {
      const [value, team] = await Promise.all([
        cloudApi<Directory>("/personal-projects/directory"),
        cloudApi<{ available: boolean }>("/projects/capabilities").catch(() => ({ available: false })),
      ]);
      setTeamAvailable(team.available === true);
      if (!readableDirectory(value)) throw new Error("The member list could not be read. Try loading again.");
      setDirectory(value);
    } catch (failure) {
      setError(cloudError(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const teamDirty = useCallback((value: boolean) => setDirty((current) => (current.team === value ? current : { ...current, team: value })), []);
  const personalDirty = useCallback((value: boolean) => setDirty((current) => (current.personal === value ? current : { ...current, personal: value })), []);
  const teamBusy = useCallback((value: boolean) => setBusy((current) => (current.team === value ? current : { ...current, team: value })), []);
  const personalBusy = useCallback((value: boolean) => setBusy((current) => (current.personal === value ? current : { ...current, personal: value })), []);
  const anyDirty = dirty.team || dirty.personal;
  const anyBusy = busy.team || busy.personal;
  useEffect(() => {
    onDirtyChange(anyDirty);
    return () => onDirtyChange(false);
  }, [anyDirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange(anyBusy);
    return () => onBusyChange(false);
  }, [anyBusy, onBusyChange]);
  if (error)
    return (
      <div className="space-y-3 py-2">
        <p role="alert" className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
      </div>
    );
  if (!directory) return <p role="status" className="py-8 text-sm text-muted-foreground">Loading members and teams…</p>;
  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        Decide who can start new projects. Administrators can create team projects and, unless explicitly blocked, personal projects. Each kind is saved on its own, and changing it never removes projects that already exist.
      </p>
      {teamAvailable ? <TeamCreationPane directory={directory} onSaved={onSaved} onDirtyChange={teamDirty} onBusyChange={teamBusy} /> : <p className="text-sm text-muted-foreground">Team projects are unavailable. You can still manage personal project creation below.</p>}
      <PersonalCreationPane directory={directory} onDirtyChange={personalDirty} onBusyChange={personalBusy} />
    </div>
  );
}
