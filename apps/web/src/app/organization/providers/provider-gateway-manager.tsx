"use client";

import type {
  OrganizationProviderGateway,
  OrganizationProviderGatewayCatalogResponse,
  OrganizationProviderGatewaysResponse,
} from "@lori-enterprise/contracts";
import {
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { CatalogLogo } from "@/components/catalog-logo";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectWrapper } from "@/components/ui/select";
import { Panel, Section, SettingsRow } from "@/components/ui/section";
import { WorkModelDiscovery } from "@/components/work/work-model-discovery";
import { clientApi, ClientApiError } from "@/lib/client-api";

function sortGateways(items: OrganizationProviderGateway[]) {
  return [...items].sort(
    (left, right) =>
      left.providerName.localeCompare(right.providerName, undefined, {
        sensitivity: "base",
      }) || left.id.localeCompare(right.id),
  );
}

function modelsToInput(models: string[]) {
  return models.join(", ");
}

function parseModels(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))];
}

function modelSummary(models: string[]): string {
  if (models.length <= 3) return models.join(", ");
  return `${models.slice(0, 3).join(", ")} + ${models.length - 3} more`;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ClientApiError && error.code === "policy_revision_conflict") {
    return "Provider settings changed while this page was open. Reload the page before trying again.";
  }
  return error instanceof Error ? error.message : fallback;
}

export function OrganizationProviderGatewayManager({
  initialCatalog,
  initialGateways,
  initialRevision,
}: {
  initialCatalog: OrganizationProviderGatewayCatalogResponse;
  initialGateways: OrganizationProviderGatewaysResponse;
  initialRevision: number;
}) {
  const [gateways, setGateways] = useState(() =>
    sortGateways(initialGateways.providerGateways),
  );
  const [revision, setRevision] = useState(() =>
    Math.max(
      initialRevision,
      ...initialGateways.providerGateways.map((gateway) => gateway.policyRevision),
    ),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<OrganizationProviderGateway | null>(null);
  const [deleteCandidate, setDeleteCandidate] =
    useState<OrganizationProviderGateway | null>(null);
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [requestsPerMinute, setRequestsPerMinute] = useState("60");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const availableProviders = useMemo(
    () =>
      initialCatalog.providers.filter(
        (provider) => !gateways.some((gateway) => gateway.providerId === provider.id),
      ),
    [gateways, initialCatalog.providers],
  );
  const selectedProvider = useMemo(
    () =>
      initialCatalog.providers.find((provider) => provider.id === providerId) ?? null,
    [initialCatalog.providers, providerId],
  );

  function openCreate() {
    const first = availableProviders[0] ?? null;
    setEditing(null);
    setProviderId(first?.id ?? "");
    setApiKey("");
    setModels(first?.defaultModel ?? "");
    setRequestsPerMinute("60");
    setError(null);
    setMessage(null);
    setEditorOpen(true);
  }

  function openEdit(gateway: OrganizationProviderGateway) {
    setEditing(gateway);
    setProviderId(gateway.providerId);
    setApiKey("");
    setModels(modelsToInput(gateway.enabledModels));
    setRequestsPerMinute(String(gateway.requestsPerMinute));
    setError(null);
    setMessage(null);
    setEditorOpen(true);
  }

  function closeEditor() {
    if (pending) return;
    setEditorOpen(false);
    setEditing(null);
    setApiKey("");
    setError(null);
  }

  function changeProvider(nextProviderId: string) {
    setProviderId(nextProviderId);
    const provider = initialCatalog.providers.find((item) => item.id === nextProviderId);
    if (provider?.defaultModel) setModels(provider.defaultModel);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const enabledModels = parseModels(models);
    const rate = Number(requestsPerMinute);
    if (enabledModels.length === 0) {
      setError("Add at least one allowed model.");
      return;
    }
    if (enabledModels.length > 32) {
      setError("Choose no more than 32 allowed models.");
      return;
    }
    if (
      enabledModels.some(
        (model) =>
          model.length > 160 || /[\u0000-\u001F\u007F]/.test(model),
      )
    ) {
      setError("Each model ID must be a single line of 160 characters or fewer.");
      return;
    }
    if (!Number.isInteger(rate) || rate < 1 || rate > 600) {
      setError("Requests per minute must be a whole number between 1 and 600.");
      return;
    }
    if (!editing && !apiKey.trim()) {
      setError("Enter the provider API key. It is encrypted on the Enterprise server.");
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const gateway = editing
        ? await clientApi<OrganizationProviderGateway>(
            `/v1/admin/provider-gateways/${encodeURIComponent(editing.id)}`,
            {
              body: JSON.stringify({
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                enabledModels,
                expectedRevision: revision,
                requestsPerMinute: rate,
              }),
              method: "PATCH",
            },
          )
        : await clientApi<OrganizationProviderGateway>(
            "/v1/admin/provider-gateways",
            {
              body: JSON.stringify({
                apiKey: apiKey.trim(),
                enabledModels,
                expectedRevision: revision,
                providerId,
                requestsPerMinute: rate,
              }),
              method: "POST",
            },
          );
      setRevision(gateway.policyRevision);
      setGateways((current) =>
        sortGateways(
          editing
            ? current.map((item) => (item.id === gateway.id ? gateway : item))
            : [...current, gateway],
        ),
      );
      setEditorOpen(false);
      setEditing(null);
      setApiKey("");
      setMessage(
        editing
          ? `${gateway.providerName} provider settings saved.`
          : `${gateway.providerName} is connected. Assign it in an access policy to make it available.`,
      );
    } catch (requestError) {
      setError(errorMessage(requestError, "The organization provider could not be saved."));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!deleteCandidate) return;
    setPending(true);
    setError(null);
    try {
      await clientApi(
        `/v1/admin/provider-gateways/${encodeURIComponent(deleteCandidate.id)}?expectedRevision=${revision}`,
        { method: "DELETE" },
      );
      setRevision((current) => current + 1);
      setGateways((current) =>
        current.filter((gateway) => gateway.id !== deleteCandidate.id),
      );
      setMessage(
        `${deleteCandidate.providerName} was disconnected. Existing organization assignments no longer configure a usable provider.`,
      );
      setDeleteCandidate(null);
    } catch (requestError) {
      setError(errorMessage(requestError, "The organization provider could not be disconnected."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8">
      {message ? <Alert variant="success">{message}</Alert> : null}
      {error && !editorOpen && !deleteCandidate ? (
        <Alert variant="destructive">{error}</Alert>
      ) : null}

      <Alert>
        Lori Enterprise keeps the upstream API key on the server. An assigned,
        enrolled device receives only a time-limited provider credential, and
        every request is checked again against its current organization, team,
        and member access policy.
      </Alert>

      <Section
        action={
          <Button disabled={availableProviders.length === 0} onClick={openCreate}>
            <PlusIcon />
            Connect provider
          </Button>
        }
        description="A connection does not grant access by itself. Assign the provider through the organization or a team after connecting it."
        title="Company provider connections"
      >
        {gateways.length === 0 ? (
          <Panel>
            <EmptyState
              action={
                <Button disabled={availableProviders.length === 0} onClick={openCreate}>
                  <PlusIcon />
                  Connect a provider
                </Button>
              }
              description="Connect a company-owned API key once. Members only receive access after you assign that provider."
              icon={KeyRoundIcon}
              title="No organization providers connected"
            />
          </Panel>
        ) : (
          <Panel>
            {gateways.map((gateway) => (
              <SettingsRow
                description={`${modelSummary(gateway.enabledModels)} · ${gateway.requestsPerMinute} requests/minute per enrolled device`}
                hint="Upstream key stored encrypted; never sent to devices"
                icon={<CatalogLogo id={gateway.providerId} type="provider" />}
                key={gateway.id}
                label={gateway.providerName}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{gateway.providerKind}</Badge>
                  <Button
                    aria-label={`Edit ${gateway.providerName}`}
                    onClick={() => openEdit(gateway)}
                    size="icon"
                    title="Edit provider"
                    variant="ghost"
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    aria-label={`Disconnect ${gateway.providerName}`}
                    onClick={() => {
                      setDeleteCandidate(gateway);
                      setError(null);
                    }}
                    size="icon"
                    title="Disconnect provider"
                    variant="ghost"
                  >
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </div>
              </SettingsRow>
            ))}
          </Panel>
        )}
      </Section>

      <Section
        description="Connections are intentionally separate from policy. This makes it safe to rotate a key without changing who is allowed to use it."
        title="Make a provider available"
      >
        <Panel>
          <SettingsRow
            description="Assign a connected provider to everyone, or keep it scoped to selected teams. A member-level block still wins."
            label="Provider access"
          >
            <Button asChild size="sm" variant="outline">
              <Link href="/organization/catalog/provider">Manage assignments</Link>
            </Button>
          </SettingsRow>
          <SettingsRow
            description="The desktop refreshes access automatically. Removing a provider assignment or revoking a device stops gateway requests immediately; it never exposes the upstream key."
            label="Enforcement"
          >
            <ShieldCheckIcon aria-hidden className="size-5 text-success" />
          </SettingsRow>
        </Panel>
      </Section>

      <Dialog
        description={
          editing
            ? "Update allowed models, per-device rate protection, or rotate the stored upstream key. Leave the key blank to keep the current encrypted key."
            : "The upstream key is encrypted on the Enterprise server. It will never be returned to this browser or a member’s Lori installation."
        }
        onClose={closeEditor}
        open={editorOpen}
        title={editing ? `Edit ${editing.providerName}` : "Connect organization provider"}
      >
        <form className="space-y-4" onSubmit={save}>
          {error ? (
            <Alert variant="destructive">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span>{error}</span>
                {error.includes("Reload the page") ? (
                  <Button
                    disabled={pending}
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
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="organization-provider">Provider</Label>
            <SelectWrapper>
              <Select
                disabled={Boolean(editing) || pending}
                id="organization-provider"
                onChange={(event) => changeProvider(event.target.value)}
                required
                value={providerId}
              >
                {!editing && availableProviders.length === 0 ? (
                  <option value="">All supported providers are connected</option>
                ) : null}
                {(editing ? initialCatalog.providers : availableProviders).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} ({provider.kind})
                  </option>
                ))}
              </Select>
            </SelectWrapper>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="organization-provider-key">
              {editing ? "Replace API key (optional)" : "Provider API key"}
            </Label>
            <Input
              autoComplete="new-password"
              autoFocus={!editing}
              id="organization-provider-key"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={editing ? "Enter a new key to rotate" : "Paste the company key"}
              required={!editing}
              spellCheck={false}
              type="password"
              value={apiKey}
            />
          </div>
          {editing ? (
            <WorkModelDiscovery
              disabled={pending}
              gatewayId={editing.id}
              selected={parseModels(models)}
              onToggle={(id, allowed) =>
                setModels((current) =>
                  modelsToInput(
                    allowed
                      ? parseModels(`${current},${id}`)
                      : parseModels(current).filter((model) => model !== id),
                  ),
                )
              }
            />
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="organization-provider-models">Allowed models</Label>
            <Input
              id="organization-provider-models"
              onChange={(event) => setModels(event.target.value)}
              placeholder={selectedProvider?.defaultModel ?? "gpt-4o"}
              required
              value={models}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Separate model IDs with commas. Requests for every other model are rejected by the gateway.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="organization-provider-rpm">Requests per minute per device</Label>
            <Input
              id="organization-provider-rpm"
              max="600"
              min="1"
              onChange={(event) => setRequestsPerMinute(event.target.value)}
              required
              type="number"
              value={requestsPerMinute}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={closeEditor} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={pending || (!editing && !providerId)} type="submit">
              {pending ? "Saving…" : editing ? "Save provider" : "Connect provider"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        description="The upstream API key and every device-issued gateway credential for this connection will stop working immediately. Existing policy assignments are preserved, so you can reconnect the provider later without recreating access rules."
        onClose={() => {
          if (!pending) {
            setDeleteCandidate(null);
            setError(null);
          }
        }}
        open={Boolean(deleteCandidate)}
        title={`Disconnect ${deleteCandidate?.providerName ?? "provider"}?`}
      >
        <div className="space-y-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={() => setDeleteCandidate(null)} type="button" variant="outline">
              Keep provider
            </Button>
            <Button disabled={pending} onClick={() => void remove()} type="button" variant="destructive">
              <Trash2Icon />
              {pending ? "Disconnecting…" : "Disconnect provider"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
