"use client";
import { useEffect, useState } from "react";
import { delegationApproves, resolveProjectPolicy } from "@lori-enterprise/contracts";
import type { PolicyCatalog, ProjectPolicy, ProjectResourceMode, WorkDelegationPolicy, WorkProviderGatewaysResponse } from "@lori-enterprise/contracts";
import { workApi } from "@/lib/work-api";
import { cloudError } from "@/lib/cloud-work-api";
import { settings } from "./project-settings";

interface Choice { key: string; label: string; approved: boolean; note?: string }

function ModeSection({ title, mode, onMode, choices, selected, onToggle, disabled, kind }: {
  title: string; kind: string; mode: ProjectResourceMode; onMode: (mode: ProjectResourceMode) => void;
  choices: Choice[]; selected: (key: string) => boolean; onToggle: (key: string, on: boolean) => void; disabled: boolean;
}) {
  const name = `project-${kind}-mode`;
  const count = choices.filter(choice => selected(choice.key)).length;
  return <fieldset className="space-y-3 border-t border-border pt-4">
    <legend className="text-sm font-medium">{title}</legend>
    <div className="grid gap-2 text-sm">
      <label className="flex items-start gap-2"><input type="radio" name={name} className="mt-1" disabled={disabled} checked={mode === "inherit"} onChange={() => onMode("inherit")} /><span>Use each member’s Work access<span className="block text-xs leading-5 text-muted-foreground">Members use the {kind} already assigned to them in Work.</span></span></label>
      <label className="flex items-start gap-2"><input type="radio" name={name} className="mt-1" disabled={disabled} checked={mode === "assigned"} onChange={() => onMode("assigned")} /><span>Assign {kind} to this project<span className="block text-xs leading-5 text-muted-foreground">Exactly the selected {kind} are usable here by members who can work in the project, even without a general assignment. They never become available outside this project.</span></span></label>
    </div>
    {mode === "assigned" && <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{count ? `${count} selected.` : `None selected: no ${kind} are available in this project.`} Only organization-approved {kind} can be added.</p>
      {choices.length ? <div className="grid gap-2 sm:grid-cols-2">{choices.map(choice => {
        const on = selected(choice.key);
        return <label key={choice.key} className="flex gap-2 text-xs"><input type="checkbox" disabled={disabled || (!on && !choice.approved)} checked={on} onChange={e => onToggle(choice.key, e.target.checked)} /><span className="break-all">{choice.label}{choice.note && <span className="ml-1 text-muted-foreground">· {choice.note}</span>}</span></label>;
      })}</div> : <p className="text-xs text-muted-foreground">The organization has not approved any {kind} yet. Approve them in Work access.</p>}
    </div>}
  </fieldset>;
}

export function ProjectPolicyControls({ policy: raw, onChange, disabled }: { policy: ProjectPolicy; onChange: (value: ProjectPolicy) => void; disabled: boolean }) {
  const policy = resolveProjectPolicy(raw);
  const [approved, setApproved] = useState<WorkDelegationPolicy["effective"] | null>(null);
  const [catalog, setCatalog] = useState<PolicyCatalog["items"]>([]);
  const [gateways, setGateways] = useState<WorkProviderGatewaysResponse["providerGateways"]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.all([
      workApi<WorkDelegationPolicy>("/v1/admin/work/delegation"),
      workApi<PolicyCatalog>("/v1/admin/work/catalog"),
      workApi<WorkProviderGatewaysResponse>("/v1/admin/work/provider-gateways"),
    ]).then(([delegation, items, providers]) => {
      if (!alive) return;
      setApproved(delegation.effective ?? null); setCatalog(items.items); setGateways(providers.providerGateways);
    }).catch(f => { if (alive) setError(cloudError(f)); });
    return () => { alive = false; };
  }, []);
  const providerName = (id: string) => gateways.find(g => g.providerId === id)?.providerName ?? catalog.find(item => item.type === "provider" && item.id === id)?.name ?? id;
  const modelChoices = new Map<string, Choice>();
  for (const row of approved?.providerModels ?? []) for (const model of row.modelIds) {
    const connected = gateways.some(g => g.providerId === row.providerId);
    // The server also requires the provider itself to be approved.
    const providerOk = (!!approved && delegationApproves(approved, { id: row.providerId, type: "provider" })) || policy.providerModels.some(p => p.providerId === row.providerId);
    modelChoices.set(`${row.providerId}\0${model}`, { key: `${row.providerId}\0${model}`, label: `${providerName(row.providerId)} · ${model}`, approved: providerOk, ...(!providerOk ? { note: "provider not approved, unavailable" } : connected ? {} : { note: "no company connection" }) });
  }
  for (const row of policy.providerModels) for (const model of row.modelIds) {
    const key = `${row.providerId}\0${model}`;
    if (!modelChoices.has(key)) modelChoices.set(key, { key, label: `${providerName(row.providerId)} · ${model}`, approved: false, note: "not approved, unavailable" });
  }
  const extensionChoices = (kind: "plugin" | "skill", assigned: string[]) => {
    const choices = new Map<string, Choice>();
    for (const item of catalog.filter(entry => entry.type === kind)) {
      const ok = !!approved && delegationApproves(approved, item);
      if (ok || assigned.includes(item.id)) choices.set(item.id, { key: item.id, label: item.name, approved: ok, ...(ok ? {} : { note: "not approved, unavailable" }) });
    }
    for (const id of assigned) if (!choices.has(id)) choices.set(id, { key: id, label: id, approved: false, note: "not approved, unavailable" });
    return [...choices.values()];
  };
  const setModels = (key: string, on: boolean) => {
    const [providerId, model] = key.split("\0") as [string, string];
    const ids = new Set(policy.providerModels.find(p => p.providerId === providerId)?.modelIds ?? []);
    if (on) ids.add(model); else ids.delete(model);
    onChange({ ...policy, providerModels: [...policy.providerModels.filter(p => p.providerId !== providerId), ...(ids.size ? [{ providerId, modelIds: [...ids].sort() }] : [])] });
  };
  return <div className="space-y-5">
    <div className="divide-y divide-border">{settings.map(item => <label key={item.key} className="flex items-start justify-between gap-4 py-3 text-sm"><span>{item.label}<span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{item.description}</span></span><input type="checkbox" className="mt-1" disabled={disabled} checked={policy[item.key]} onChange={e => onChange({ ...policy, [item.key]: e.target.checked })} /></label>)}</div>
    <ModeSection title="Models" kind="models" mode={policy.providerMode} disabled={disabled} onMode={providerMode => onChange({ ...policy, providerMode })} choices={[...modelChoices.values()]} selected={key => { const [p, m] = key.split("\0"); return policy.providerModels.some(row => row.providerId === p && row.modelIds.includes(m!)); }} onToggle={setModels} />
    <ModeSection title="Plugins" kind="plugins" mode={policy.pluginMode} disabled={disabled} onMode={pluginMode => onChange({ ...policy, pluginMode })} choices={extensionChoices("plugin", policy.pluginIds)} selected={id => policy.pluginIds.includes(id)} onToggle={(id, on) => onChange({ ...policy, pluginIds: on ? [...policy.pluginIds, id] : policy.pluginIds.filter(value => value !== id) })} />
    <ModeSection title="Skills" kind="skills" mode={policy.skillMode} disabled={disabled} onMode={skillMode => onChange({ ...policy, skillMode })} choices={extensionChoices("skill", policy.skillIds)} selected={id => policy.skillIds.includes(id)} onToggle={(id, on) => onChange({ ...policy, skillIds: on ? [...policy.skillIds, id] : policy.skillIds.filter(value => value !== id) })} />
    <p className="text-xs leading-5 text-muted-foreground">Plugins use connections configured for this project; personal accounts are never inherited.</p>
    {error && <p role="alert" className="text-xs text-destructive">Approved resources could not be loaded: {error}. Saved assignments are preserved.</p>}
  </div>;
}
