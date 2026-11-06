"use client";

import type {
  CatalogIdentity,
  CodeDelegationPolicy,
  PolicyCatalog,
  PolicyCatalogItemType,
  WorkDelegationPolicy,
} from "@lori-enterprise/contracts";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Section } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { ClientApiError } from "@/lib/client-api";
import { workApi } from "@/lib/work-api";

type Product = "code" | "work";
type Draft = {
  enabled: boolean;
  personalInstallations: { plugins: boolean; providers: boolean; skills: boolean };
  managedCatalog: CatalogIdentity[];
  providerModels: { providerId: string; modelIds: string[] }[];
};
type Loaded = (CodeDelegationPolicy | WorkDelegationPolicy) & { enabled?: boolean; providerModels?: Draft["providerModels"] };

const key = (item: Pick<CatalogIdentity, "id" | "type">) => `${item.type}:${item.id}`;
const typeLabels: Record<PolicyCatalogItemType, string> = { app: "Apps", plugin: "Plugins", provider: "Providers", skill: "Skills" };

function draftOf(value: Loaded): Draft {
  return {
    enabled: value.enabled ?? false,
    personalInstallations: { ...value.personalInstallations },
    managedCatalog: [...value.managedCatalog],
    providerModels: (value.providerModels ?? []).map((row) => ({ ...row, modelIds: [...row.modelIds] })),
  };
}

function normalized(draft: Draft, product: Product) {
  const catalog = [...new Map(draft.managedCatalog.map((item) => [key(item), item])).values()].sort((a, b) => key(a).localeCompare(key(b)));
  return product === "work"
    ? {
        enabled: draft.enabled,
        personalInstallations: draft.personalInstallations,
        managedCatalog: catalog,
        providerModels: draft.providerModels
          .filter((row) => row.modelIds.length)
          .map((row) => ({ providerId: row.providerId, modelIds: [...new Set(row.modelIds)].sort() }))
          .sort((a, b) => a.providerId.localeCompare(b.providerId)),
      }
    : { personalInstallations: draft.personalInstallations, managedCatalog: catalog };
}

/**
 * The organization-approved ceiling for team administrators. Organization
 * defaults are always approved and shown as such; team grants outside the
 * ceiling never take effect.
 */
export function DelegationEditor({ product, catalog }: { product: Product; catalog: PolicyCatalog }) {
  const endpoint = product === "work" ? "/v1/admin/work/delegation" : "/v1/admin/policy/delegation";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modelProvider, setModelProvider] = useState("");
  const [modelId, setModelId] = useState("");

  async function load() {
    setError(null);
    try {
      const value = await workApi<Loaded>(endpoint);
      setLoaded(value);
      setDraft(draftOf(value));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Team delegation could not be loaded.");
    }
  }
  // The endpoint is fixed per product, so this loads once.
  useEffect(() => {
    void load();
  }, [endpoint]);

  const dirty = !!loaded && !!draft && JSON.stringify(normalized(draft, product)) !== JSON.stringify(normalized(draftOf(loaded), product));
  // Also guards in-app links (section tabs, sidebar), not just reloads.
  useUnsavedChanges(dirty && !busy);

  const defaults = useMemo(() => {
    const stored = new Set((loaded?.managedCatalog ?? []).map(key));
    return new Set((loaded?.effective?.managedCatalog ?? []).map(key).filter((item) => !stored.has(item)));
  }, [loaded]);
  const defaultModels = useMemo(() => {
    const stored = new Set((loaded?.providerModels ?? []).flatMap((row) => row.modelIds.map((m) => `${row.providerId}\0${m}`)));
    const effective = (loaded?.effective as WorkDelegationPolicy["effective"])?.providerModels ?? [];
    return effective.flatMap((row) => row.modelIds.map((m) => ({ providerId: row.providerId, modelId: m }))).filter((m) => !stored.has(`${m.providerId}\0${m.modelId}`));
  }, [loaded]);

  if (!draft || !loaded)
    return error ? <Alert variant="destructive">{error} <button className="underline" onClick={() => void load()} type="button">Retry</button></Alert> : <p role="status" className="text-sm text-muted-foreground">Loading team delegation…</p>;

  const workByDefault = !!(loaded.effective as WorkDelegationPolicy["effective"] | undefined)?.enabled && !loaded.enabled;
  const types = (product === "work" ? ["provider", "plugin", "skill"] : ["app", "plugin", "skill", "provider"]) as PolicyCatalogItemType[];
  const providers = catalog.items.filter((item) => item.type === "provider");
  // Organization-wide personal installation, as opposed to what teams may allow.
  const orgPersonal = (flag: "plugins" | "skills") =>
    !!loaded.effective?.personalInstallations[flag] && !loaded.personalInstallations[flag];
  const providerApproved = (providerId: string) =>
    defaults.has(key({ id: providerId, type: "provider" })) ||
    draft.managedCatalog.some((entry) => entry.type === "provider" && entry.id === providerId);
  const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
  const toggle = (item: CatalogIdentity, on: boolean) =>
    setDraft((current) => current && ({
      ...current,
      managedCatalog: on ? [...current.managedCatalog, item] : current.managedCatalog.filter((entry) => key(entry) !== key(item)),
    }));

  async function save() {
    if (!draft || !loaded) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const value = await workApi<Loaded>(endpoint, {
        body: JSON.stringify({ delegation: normalized(draft, product), expectedRevision: loaded.revision }),
        method: "PUT",
      });
      setLoaded(value); setDraft(draftOf(value)); setSaved(true);
    } catch (failure) {
      setError(
        failure instanceof ClientApiError && failure.code === "policy_revision_conflict"
          ? "Policy changed elsewhere. Reload to review the latest approvals; your edits are still here."
          : failure instanceof Error ? failure.message : "Team delegation could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Section
        description="Team admins can grant only what you approve here, plus what the organization already gives everyone. Removing an approval stops existing team grants of it from taking effect; it does not delete them."
        title="Team delegation"
      >
        <Panel className="space-y-5 p-4 sm:p-5">
          {product === "work" && (
            <label className="flex items-start gap-3 text-sm">
              <input checked={draft.enabled || workByDefault} className="mt-1" disabled={busy || workByDefault} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} type="checkbox" />
              <span>Teams may turn on Work<span className="block text-xs text-muted-foreground">{workByDefault ? "Work is on for everyone by organization default." : "Lets team admins enable Work for their members."}</span></span>
            </label>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Personal installations teams may allow</legend>
            {(["plugins", "providers", "skills"] as const).map((flag) => {
              const byDefault = !!loaded.effective?.personalInstallations[flag] && !loaded.personalInstallations[flag];
              return (
                <label className="flex items-center gap-2 text-sm" key={flag}>
                  <input checked={draft.personalInstallations[flag] || byDefault} disabled={busy || byDefault} onChange={(e) => setDraft({ ...draft, personalInstallations: { ...draft.personalInstallations, [flag]: e.target.checked } })} type="checkbox" />
                  <span className="capitalize">{flag}</span>
                  {byDefault && <span className="text-xs text-muted-foreground">· organization default</span>}
                </label>
              );
            })}
          </fieldset>
          {types.map((type) => (
            <fieldset className="space-y-2" key={type}>
              <legend className="text-sm font-medium">{typeLabels[type]} teams may assign</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {catalog.items.filter((item) => item.type === type).map((item) => {
                  const identity = { id: item.id, type: item.type };
                  const byDefault = defaults.has(key(identity));
                  // A plugin or skill is covered when everyone may install that kind
                  // (organization default) or when teams may allow it (this draft),
                  // unless the organization turned the item off.
                  const flag = type === "plugin" ? "plugins" : type === "skill" ? "skills" : null;
                  const offByOrganization = !!loaded.effective?.blockedCatalog?.some((entry) => key(entry) === key(identity));
                  const everyone = !!flag && orgPersonal(flag);
                  const teamsMayAllow = !!flag && !everyone && draft.personalInstallations[flag];
                  const byPersonal = !byDefault && !offByOrganization && (everyone || teamsMayAllow);
                  return (
                    <label className="flex items-center gap-2 text-xs" key={key(identity)}>
                      <input checked={byDefault || byPersonal || draft.managedCatalog.some((entry) => key(entry) === key(identity))} disabled={busy || byDefault || byPersonal} onChange={(e) => toggle(identity, e.target.checked)} type="checkbox" />
                      <span className="break-all">{item.name}</span>
                      {byDefault && <span className="text-muted-foreground">· default</span>}
                      {byPersonal && <span className="text-muted-foreground">· {everyone ? "everyone may install" : "covered by personal installations"}</span>}
                      {offByOrganization && !byDefault && <span className="text-muted-foreground">· turned off for the organization</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          {product === "work" && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Models teams may assign</legend>
              <ul className="space-y-1 text-xs">
                {defaultModels.map((model) => (
                  <li className="text-muted-foreground" key={`d:${model.providerId}:${model.modelId}`}>{providerName(model.providerId)} · {model.modelId} · organization default</li>
                ))}
                {draft.providerModels.flatMap((row) => row.modelIds.map((model) => (
                  <li className="flex items-center justify-between gap-2" key={`${row.providerId}:${model}`}>
                    <span className="break-all">{providerName(row.providerId)} · {model}{!providerApproved(row.providerId) && <span className="text-muted-foreground"> · provider not approved, unavailable</span>}</span>
                    <Button disabled={busy} onClick={() => setDraft({ ...draft, providerModels: draft.providerModels.map((entry) => entry.providerId === row.providerId ? { ...entry, modelIds: entry.modelIds.filter((m) => m !== model) } : entry) })} size="sm" type="button" variant="ghost">Remove</Button>
                  </li>
                )))}
              </ul>
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
                e.preventDefault();
                const id = modelId.trim();
                if (!modelProvider || !id) return;
                const existing = draft.providerModels.find((row) => row.providerId === modelProvider);
                setDraft({
                  ...draft,
                  // A model is only usable through its provider, so approve both together.
                  managedCatalog: providerApproved(modelProvider)
                    ? draft.managedCatalog
                    : [...draft.managedCatalog, { id: modelProvider, type: "provider" }],
                  providerModels: existing
                    ? draft.providerModels.map((row) => row.providerId === modelProvider ? { ...row, modelIds: [...new Set([...row.modelIds, id])] } : row)
                    : [...draft.providerModels, { providerId: modelProvider, modelIds: [id] }],
                });
                setModelId("");
              }}>
                <SelectWrapper className="w-44">
                  <Select aria-label="Provider" onChange={(e) => setModelProvider(e.target.value)} value={modelProvider}>
                    <option value="">Provider</option>
                    {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </Select>
                </SelectWrapper>
                <Input aria-label="Model ID" className="w-56" maxLength={128} onChange={(e) => setModelId(e.target.value)} placeholder="Model ID" value={modelId} />
                <Button disabled={busy || !modelProvider || !modelId.trim()} size="sm" type="submit" variant="outline">Approve model</Button>
              </form>
            </fieldset>
          )}
          {error && <Alert variant="destructive">{error}</Alert>}
          {saved && !dirty && <p role="status" className="text-sm text-muted-foreground">Team delegation saved.</p>}
          <div className="flex gap-2">
            <Button disabled={busy || !dirty} onClick={() => void save()} type="button">{busy ? "Saving…" : "Save delegation"}</Button>
            <Button disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard unsaved delegation changes?")) void load(); }} type="button" variant="ghost">Reload</Button>
          </div>
        </Panel>
      </Section>
    </div>
  );
}
