"use client";
import { WorkModelPricing } from "./work-model-pricing";
import { WorkModelDiscovery } from "./work-model-discovery";
import { CatalogLogo } from "@/components/catalog-logo";

import type {
  EnterpriseWorkPolicy,
  PolicyCatalog,
  PolicyCatalogItem,
  WorkModelOverride,
} from "@lori-enterprise/contracts";
import {
  ChevronDownIcon,
  KeyRoundIcon,
  Loader2Icon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";
import { workApi as clientApi } from "@/lib/work-api";
import { WorkCatalogDecision } from "./work-extension-assignments";
import type { WorkMode } from "./work-policy-types";
import { WorkProviderConnectionDialog } from "./work-provider-connection-dialog";
import {
  connectionFailure,
  validWorkModelId,
  validConnections,
  type WorkProviderConnection,
  type WorkProviderConnections,
} from "./work-provider-utils";

export interface WorkProviderAssignmentsProps {
  catalog: PolicyCatalog;
  mode: WorkMode;
  readOnly: boolean;
  disabled: boolean;
  inherited: EnterpriseWorkPolicy;
  effective: EnterpriseWorkPolicy;
  managedCatalog: EnterpriseWorkPolicy["managedCatalog"];
  providerModels: EnterpriseWorkPolicy["providerModels"];
  modelOverrides?: WorkModelOverride[];
  onCatalog(id: string, type: "provider", enabled: boolean | null): void;
  onModel(providerId: string, modelId: string, enabled: boolean | null): void;
  canManageConnections?: boolean;
  /** An individual's workspace: the key is theirs, not a company's. */
  personalWorkspace?: boolean;
  onConnectionsChanged?(revision: number): void;
  onReviewLatest?(): void;
}
function Decision({
  label,
  value,
  inherited,
  disabled,
  block,
  onChange,
}: {
  label: string;
  value: boolean | null;
  inherited: boolean;
  disabled: boolean;
  block: boolean;
  onChange(value: boolean | null): void;
}) {
  return (
    <SelectWrapper className="w-full sm:w-44">
      <Select
        aria-label={label}
        disabled={disabled}
        value={value === null ? "inherit" : value ? "allow" : "deny"}
        onChange={(event) =>
          onChange(
            event.target.value === "inherit"
              ? null
              : event.target.value === "allow",
          )
        }
      >
        <option value="inherit">
          Inherit ({inherited ? "allowed" : "not granted"})
        </option>
        <option value="allow">Allow</option>
        <option value="deny">{block ? "Block" : "Remove grant"}</option>
      </Select>
    </SelectWrapper>
  );
}
function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h4 className="text-sm font-medium">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}
export function WorkProviderAssignments(props: WorkProviderAssignmentsProps) {
  const {
    catalog,
    mode,
    readOnly: requestedReadOnly,
    disabled,
    inherited,
    effective,
    managedCatalog,
    providerModels,
    modelOverrides = [],
    onCatalog,
    onModel,
    onConnectionsChanged,
    personalWorkspace = false,
  } = props;
  const keyName = personalWorkspace ? "API key" : "company key";
  const readOnly = requestedReadOnly || mode === "viewer";
  const isOverride = mode === "member" || mode === "team-member";
  const orgAdmin =
    props.canManageConnections === true && mode === "organization" && !readOnly;
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modelInput, setModelInput] = useState<Record<string, string>>({});
  const [modelError, setModelError] = useState<string | null>(null);
  const [pricingSaves, setPricingSaves] = useState(0);
  const [syncPending, setSyncPending] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [connections, setConnections] = useState<
    WorkProviderConnection[] | null
  >(null);
  const [loading, setLoading] = useState(orgAdmin);
  const [failure, setFailure] = useState<ReturnType<
    typeof connectionFailure
  > | null>(null);
  const [reload, setReload] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!orgAdmin) {
      setEditing(null);
      setConnections(null);
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setFailure(null);
    void clientApi<WorkProviderConnections>(
      "/v1/admin/work/provider-gateways",
      { signal: abort.signal },
    )
      .then((response) => {
        if (
          !validConnections(response) ||
          response.revision < effective.revision
        )
          throw new Error("Invalid connection metadata");
        if (current === generation.current)
          setConnections(response.providerGateways);
      })
      .catch((reason) => {
        if (current === generation.current && !abort.signal.aborted) {
          const next = connectionFailure(reason);
          setFailure(next);
          if (next.retryAfterSeconds) {
            setNow(Date.now());
            setRetryAt(Date.now() + next.retryAfterSeconds * 1000);
          }
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [orgAdmin, reload, effective.revision]);
  const connectedIds = new Set(
    connections === null
      ? (catalog.connectedOrganizationProviderIds ?? [])
      : connections.map((c) => c.providerId),
  );
  const decision = (id: string) =>
    managedCatalog.find((item) => item.type === "provider" && item.id === id)
      ?.enabled ?? null;
  const inheritedProvider = (id: string) =>
    inherited.managedCatalog.some(
      (item) => item.type === "provider" && item.id === id && item.enabled,
    );
  const models = (id: string) =>
    readOnly
      ? (effective.providerModels.find((entry) => entry.providerId === id)
          ?.modelIds ?? [])
      : isOverride
        ? [
            ...new Set([
              ...(inherited.providerModels.find(
                (entry) => entry.providerId === id,
              )?.modelIds ?? []),
              ...modelOverrides
                .filter((entry) => entry.providerId === id)
                .map((entry) => entry.modelId),
            ]),
          ]
        : (providerModels.find((entry) => entry.providerId === id)?.modelIds ??
          []);
  const modelAllowed = (id: string, model: string) =>
    isOverride
      ? (modelOverrides.find(
          (entry) => entry.providerId === id && entry.modelId === model,
        )?.enabled ??
        inherited.providerModels.some(
          (entry) => entry.providerId === id && entry.modelIds.includes(model),
        ))
      : true;
  async function setAutoModels(gatewayId: string, autoModels: boolean) {
    if (syncPending) return;
    setSyncPending(true);
    setSyncError(null);
    try {
      const saved = await clientApi<WorkProviderConnection>(
        `/v1/admin/work/provider-gateways/${encodeURIComponent(gatewayId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ autoModels, expectedRevision: effective.revision }),
        },
      );
      setReload((n) => n + 1);
      onConnectionsChanged?.(saved.policyRevision);
    } catch (reason) {
      setSyncError(connectionFailure(reason).message);
    } finally {
      setSyncPending(false);
    }
  }
  function submitCustomModel(providerId: string, ids: string[], allowed: string[]) {
    const model = (modelInput[providerId] ?? "").trim();
    if (disabled) return;
    if (!validWorkModelId(model)) {
      setModelError("Enter a single-line model ID of 1–128 characters.");
      return;
    }
    if (ids.includes(model) && modelAllowed(providerId, model)) {
      setModelError("This model is already allowed.");
      return;
    }
    if (allowed.length >= 32) {
      setModelError("Choose no more than 32 allowed models per provider.");
      return;
    }
    onModel(providerId, model, true);
    setModelInput((current) => ({ ...current, [providerId]: "" }));
    setModelError(null);
  }
  const all = catalog.items.filter((item) => item.type === "provider");
  const available = readOnly
    ? all.filter(
        (item) =>
          effective.enabled &&
          connectedIds.has(item.id) &&
          effective.managedCatalog.some(
            (grant) =>
              grant.type === "provider" &&
              grant.id === item.id &&
              grant.enabled,
          ) &&
          models(item.id).length > 0,
      )
    : all;
  const visible = available.filter((item) =>
    `${item.name} ${item.description} ${models(item.id).join(" ")}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const statusUnknown = orgAdmin && (loading || failure !== null);

  function renderProvider(item: PolicyCatalogItem) {
    const ids = models(item.id);
    const allowed = ids.filter((model) => modelAllowed(item.id, model));
    const open = expanded === item.id;
    const ready = connectedIds.has(item.id);
    const connection = connections?.find((c) => c.providerId === item.id);
    const sync = connection?.modelSync;
    const automatic = sync?.enabled === true;
    const blocked = decision(item.id) === false;
    const providerDecision =
      decision(item.id) ?? (automatic && sync.modelIds.length > 0 ? true : null);
    const notShared =
      mode === "organization" &&
      ready &&
      !statusUnknown &&
      !personalWorkspace &&
      providerDecision === null &&
      allowed.length > 0;
    const canConnect = orgAdmin && !ready && !statusUnknown;
    const status = statusUnknown
      ? loading
        ? "Checking"
        : "Status unavailable"
      : automatic
        ? sync.modelIds.length
          ? `All ${sync.modelIds.length} models enabled`
          : "All models enabled"
        : allowed.length > 0
          ? `${allowed.length} ${allowed.length === 1 ? "model" : "models"}${ready ? "" : " · not connected"}`
          : ready
            ? "No models chosen"
            : mode === "organization" || personalWorkspace
              ? "Not connected"
              : "No allowed models yet";
    return (
      <li key={item.id}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
          <CatalogLogo id={item.id} type="provider" />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">{item.name}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {status}
              {notShared ? (
                <span className="text-warning-muted-foreground"> · not shared yet</span>
              ) : null}
            </p>
          </div>
          {readOnly ? (
            allowed.length <= 8 ? (
              <div className="flex w-full flex-wrap gap-1.5 sm:w-auto sm:justify-end">
                {allowed.map((model) => (
                  <span
                    key={model}
                    className="max-w-full break-all rounded border border-border px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {model}
                  </span>
                ))}
              </div>
            ) : null
          ) : (
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {isOverride ? (
                <Decision
                  label={`${item.name} assignment`}
                  disabled={disabled}
                  inherited={inheritedProvider(item.id)}
                  value={decision(item.id)}
                  block={mode === "member"}
                  onChange={(value) => onCatalog(item.id, "provider", value)}
                />
              ) : personalWorkspace ? (
                ready ? (
                  <Toggle
                    aria-label={`Use ${item.name} in Work`}
                    checked={providerDecision === true}
                    disabled={disabled}
                    onChange={(value) =>
                      onCatalog(item.id, "provider", value ? true : null)
                    }
                  />
                ) : null
              ) : mode === "organization" ? (
                canConnect ? null : (
                  <WorkCatalogDecision
                    label={`${item.name} assignment`}
                    value={providerDecision}
                    disabled={disabled}
                    onChange={(value) => onCatalog(item.id, "provider", value)}
                  />
                )
              ) : (
                <Toggle
                  aria-label={`Assign ${item.name}`}
                  checked={decision(item.id) === true}
                  disabled={disabled}
                  onChange={(value) =>
                    onCatalog(item.id, "provider", value ? true : null)
                  }
                />
              )}
              {canConnect ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Connect ${item.name}`}
                  disabled={disabled}
                  onClick={() => setEditing({ id: item.id, name: item.name })}
                >
                  Connect
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-expanded={open}
                  aria-controls={`work-provider-${item.id}`}
                  aria-label={`Configure ${item.name}`}
                  onClick={() => {
                    setExpanded(open ? null : item.id);
                    setModelError(null);
                    setSyncError(null);
                  }}
                >
                  <span>Manage</span>
                  <ChevronDownIcon
                    aria-hidden
                    className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")}
                  />
                </Button>
              )}
            </div>
          )}
        </div>
        {open && !readOnly ? (
          <div
            id={`work-provider-${item.id}`}
            className="divide-y divide-border border-t border-border"
          >
            {orgAdmin ? (
              <PanelSection
                title={personalWorkspace ? "API key" : "Company key"}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || loading || failure !== null || connections === null}
                    onClick={() => setEditing({ id: item.id, name: item.name })}
                  >
                    <KeyRoundIcon aria-hidden />
                    {ready ? `Update ${keyName}` : `Connect ${keyName}`}
                  </Button>
                }
              />
            ) : !ready && mode === "organization" ? (
              <p className="px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-5">
                An organization administrator needs to add the key. You can
                prepare models now.
              </p>
            ) : null}
            {orgAdmin && connection ? (
              <>
                <PanelSection
                  title="Models"
                  action={
                    sync ? (
                      <div
                        role="group"
                        aria-label={`${item.name} model access`}
                        className="flex gap-0.5 rounded-md bg-secondary p-0.5"
                      >
                        {([[true, "All models"], [false, "Choose models"]] as const).map(
                          ([value, label]) => (
                            <button
                              key={label}
                              type="button"
                              aria-pressed={automatic === value}
                              disabled={disabled || syncPending}
                              onClick={() => {
                                if (automatic !== value)
                                  void setAutoModels(connection.id, value);
                              }}
                              className={cn(
                                "h-9 rounded px-3 text-xs font-medium transition-colors disabled:opacity-55 sm:h-7",
                                automatic === value
                                  ? "bg-card text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {label}
                            </button>
                          ),
                        )}
                      </div>
                    ) : undefined
                  }
                >
                  {syncError ? (
                    <p role="alert" className="text-xs text-destructive">
                      {syncError}
                    </p>
                  ) : null}
                  {blocked ? (
                    <p className="text-xs text-muted-foreground">
                      This provider is blocked, so members cannot use any of its
                      models.
                    </p>
                  ) : automatic ? (
                    <p className="text-xs text-muted-foreground">
                      Every chat model that can use tools is on. New ones turn on
                      as the provider adds them.
                    </p>
                  ) : null}
                  <WorkModelDiscovery
                    gatewayId={connection.id}
                    disabled={disabled}
                    automaticIds={automatic ? sync.modelIds : undefined}
                    selected={ids}
                    refreshKey={`${connection.updatedAt}:${pricingSaves}`}
                    onToggle={(model, allowedModel) => {
                      onModel(item.id, model, allowedModel);
                      // Choosing a model for a connected key means "use this",
                      // so it must not stay unassigned.
                      if (allowedModel && decision(item.id) === null)
                        onCatalog(item.id, "provider", true);
                    }}
                    onUpdateKey={() => setEditing({ id: item.id, name: item.name })}
                  />
                  {!automatic ? (
                    <p className="text-xs text-muted-foreground">
                      Changes apply when you save Work access.
                    </p>
                  ) : null}
                </PanelSection>
                <div className="px-4 py-4 sm:px-5">
                  <WorkModelPricing
                    gatewayId={connection.id}
                    models={automatic ? [...new Set([...sync.modelIds, ...ids])] : ids}
                    disabled={disabled}
                    onSaved={(revision) => {
                      setPricingSaves((n) => n + 1);
                      onConnectionsChanged?.(revision);
                    }}
                  />
                </div>
              </>
            ) : (
              <PanelSection title="Models">
                {ids.length ? (
                  <ul className="divide-y divide-border rounded-md border border-border bg-card">
                    {ids.map((model) => (
                      <li
                        key={model}
                        className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <span className="min-w-0 break-all text-sm">{model}</span>
                        {isOverride ? (
                          <Decision
                            label={`${model} model access`}
                            disabled={disabled}
                            inherited={inherited.providerModels.some(
                              (entry) =>
                                entry.providerId === item.id &&
                                entry.modelIds.includes(model),
                            )}
                            value={
                              modelOverrides.find(
                                (entry) =>
                                  entry.providerId === item.id &&
                                  entry.modelId === model,
                              )?.enabled ?? null
                            }
                            block={mode === "member"}
                            onChange={(value) => onModel(item.id, model, value)}
                          />
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove ${model}`}
                            disabled={disabled}
                            onClick={() => onModel(item.id, model, false)}
                          >
                            <XIcon aria-hidden />
                            Remove
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitCustomModel(item.id, ids, allowed);
                  }}
                >
                  <Input
                    className="min-w-40 flex-1 sm:h-9"
                    aria-label={`${item.name} model ID`}
                    placeholder="Exact model ID from your provider"
                    maxLength={128}
                    disabled={disabled}
                    value={modelInput[item.id] ?? ""}
                    aria-invalid={modelError ? true : undefined}
                    onChange={(event) => {
                      setModelInput((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }));
                      setModelError(null);
                    }}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    className="sm:h-9"
                    disabled={disabled || !(modelInput[item.id] ?? "").trim()}
                  >
                    Add model
                  </Button>
                </form>
                {modelError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {modelError}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Changes apply when you save Work access.
                </p>
              </PanelSection>
            )}
          </div>
        ) : null}
      </li>
    );
  }

  function group(label: string | null, items: PolicyCatalogItem[]) {
    if (!items.length) return null;
    return (
      <div key={label ?? "all"} className="space-y-2">
        {label ? (
          <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
        ) : null}
        <Panel>
          <ul className="divide-y divide-border">{items.map(renderProvider)}</ul>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {readOnly
          ? effective.enabled
            ? "These company providers are available for your desktop Work workspace."
            : "Your organization has disabled Work. Saved provider assignments become available when Work is enabled."
          : personalWorkspace
            ? "Connect a provider with your API key to use its models in Work."
            : "Connect a provider, then choose who can use it and which models they get."}
      </p>
      {readOnly &&
      effective.enabled &&
      effective.personalInstallations.providers ? (
        <Alert>
          To use your own API key or a local model, open Work → LLM Providers in
          Lori desktop. Personal keys are not entered on this dashboard.
        </Alert>
      ) : null}
      {message ? <Alert variant="success">{message}</Alert> : null}
      {failure ? (
        <Alert variant="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{failure.message}</span>
            {failure.signIn ? (
              <Button asChild size="sm" variant="outline">
                <a href="/sign-in" target="_blank" rel="noreferrer">
                  Sign in again
                </a>
              </Button>
            ) : failure.reload ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  props.onReviewLatest?.();
                  setReload((n) => n + 1);
                }}
              >
                Reload latest
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading || retryAt > now}
                onClick={() => setReload((n) => n + 1)}
              >
                {retryAt > now
                  ? `Retry in ${Math.ceil((retryAt - now) / 1000)}s`
                  : "Retry connection status"}
              </Button>
            )}
          </div>
        </Alert>
      ) : null}
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search Work providers"
          placeholder="Search providers or models…"
          value={query}
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {loading ? (
        <p
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Loader2Icon
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          Checking company connection status…
        </p>
      ) : null}
      {visible.length ? (
        orgAdmin ? (
          <>
            {group("Connected", visible.filter((item) => connectedIds.has(item.id)))}
            {group("Available", visible.filter((item) => !connectedIds.has(item.id)))}
          </>
        ) : (
          group(null, visible)
        )
      ) : (
        <Panel>
          <div className="space-y-1 p-5">
            <p className="text-sm font-medium">
              {query.trim()
                ? "No providers match your search"
                : readOnly
                  ? "No company providers available"
                  : "No providers in the Work catalog"}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {query.trim()
                ? "Try a provider name or model ID."
                : readOnly
                  ? effective.enabled
                    ? "Your administrator needs to assign a connected provider and at least one model."
                    : "Your organization has disabled Work access."
                  : "Reload the catalog or contact your Enterprise administrator."}
            </p>
          </div>
        </Panel>
      )}
      {editing && orgAdmin ? (
        <WorkProviderConnectionDialog
          key={editing.id}
          providerId={editing.id}
          providerName={editing.name}
          personalWorkspace={personalWorkspace}
          connection={connections?.find(
            (connection) => connection.providerId === editing.id,
          )}
          revision={effective.revision}
          onReviewLatest={() => {
            props.onReviewLatest?.();
            setReload((n) => n + 1);
          }}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setConnections((current) => [
              ...(current ?? []).filter(
                (connection) => connection.providerId !== saved.providerId,
              ),
              saved,
            ]);
            setEditing(null);
            setExpanded(saved.providerId);
            setMessage(
              personalWorkspace
                ? `${saved.providerName} key saved.`
                : `${saved.providerName} company connection saved. Provider availability has not been verified. Review and save Work access separately.`,
            );
            onConnectionsChanged?.(saved.policyRevision);
          }}
        />
      ) : null}
    </div>
  );
}
