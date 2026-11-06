"use client";
import { NotificationSettings } from "../notifications/settings";

import type { CloudCapabilities, CloudProjectDetail, ProjectCapabilities, Viewer } from "@lori-enterprise/contracts";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  LaptopIcon,
  MoonIcon,
  ServerIcon,
  SunIcon,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { manageDestination } from "@/lib/manage-destination";
import { cn } from "@/lib/utils";
import { useEffect, useState, type ReactNode } from "react";
import { CatalogLogo } from "@/components/catalog-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CloudApprovalControl } from "./cloud-approval-control";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, SettingsRow } from "@/components/ui/section";
import { formatTokenCount } from "@/lib/cloud-work-api";
import { CloudExtensions } from "./cloud-extensions";
import { CloudMemory } from "./cloud-memory";
import { CloudSettings } from "./cloud-settings";

type View = "providers" | "plugins" | "settings";

const titles: Record<View, { title: string; description: string }> = {
  providers: {
    title: "LLM Providers",
    description: "AI providers and models made available by your organization.",
  },
  plugins: {
    title: "Plugins",
    description: "Plugins and skills assigned by your organization.",
  },
  settings: {
    title: "Settings",
    description: "Preferences and access for Enterprise Cloud Work.",
  },
};

const MODEL_COLUMNS = "grid grid-cols-[minmax(0,1fr)_3.5rem_3.5rem] items-center gap-3 px-4 sm:px-5";
const MODEL_SEARCH_THRESHOLD = 8;

function ProviderModels({
  provider,
  active,
}: {
  provider: CloudCapabilities["providers"][number];
  active?: { gatewayId: string; modelId: string };
}) {
  const [query, setQuery] = useState("");
  const total = provider.modelIds.length;
  const inUse = (model: string) =>
    active?.gatewayId === provider.gatewayId && active.modelId === model;
  const term = query.trim().toLowerCase();
  const models = [
    ...provider.modelIds.filter(inUse),
    ...provider.modelIds.filter((model) => !inUse(model)),
  ].filter((model) => model.toLowerCase().includes(term));
  return (
    <div className="border-t border-border/70">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
        <h4 className="text-xs text-muted-foreground">
          <span className="font-medium">Available models</span>
          <span className="ml-2 tabular-nums">{total}</span>
        </h4>
        {total > MODEL_SEARCH_THRESHOLD ? (
          <Input
            aria-label={`Search ${provider.name} models`}
            className="sm:h-8 sm:w-56"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
      </div>
      {models.length ? (
        <>
          <div
            aria-hidden
            className={cn(MODEL_COLUMNS, "border-y border-border/60 py-1.5 text-[11px] text-muted-foreground")}
          >
            <span>Model</span>
            <span className="text-right">Context</span>
            <span className="text-right">Reply</span>
          </div>
          <ul className="max-h-[28rem] divide-y divide-border/60 overflow-y-auto overscroll-contain">
            {models.map((model) => {
              const limits = provider.modelLimits?.[model];
              return (
                <li key={model} className={cn(MODEL_COLUMNS, "min-h-11 py-2")}>
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-all text-sm">{model}</span>
                    {inUse(model) && (
                      <Badge variant="secondary" className="gap-1">
                        <CheckIcon aria-hidden />
                        In use
                      </Badge>
                    )}
                  </span>
                  {limits ? (
                    <>
                      <span
                        className="text-right text-xs tabular-nums"
                        title={`${limits.contextTokens.toLocaleString("en-US")} tokens`}
                      >
                        <span className="sr-only">Context window </span>
                        {formatTokenCount(limits.contextTokens)}
                      </span>
                      <span
                        className="text-right text-xs tabular-nums text-muted-foreground"
                        title={`${limits.outputTokens.toLocaleString("en-US")} tokens per reply in Work`}
                      >
                        <span className="sr-only">Maximum reply </span>
                        {formatTokenCount(limits.outputTokens)}
                      </span>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="border-t border-border/60 px-4 py-8 text-center text-xs text-muted-foreground sm:px-5">
          No models match “{query.trim()}”.
        </p>
      )}
    </div>
  );
}

function LoadState({
  loading,
  onReload,
}: {
  loading: boolean;
  onReload: () => void;
}) {
  return loading ? (
    <div role="status" aria-label="Loading" className="mt-8 space-y-3">
      <div className="h-20 animate-pulse rounded-lg bg-secondary motion-reduce:animate-none" />
      <div className="h-20 animate-pulse rounded-lg bg-secondary motion-reduce:animate-none" />
    </div>
  ) : (
    <Panel className="mt-8">
      <EmptyState
        icon={ServerIcon}
        title="Cloud Work could not be loaded"
        description="Check your connection and try again. Your saved conversations are not affected."
        action={
          <Button variant="outline" size="sm" onClick={onReload}>
            Try again
          </Button>
        }
      />
    </Panel>
  );
}

export function CloudDestinations({
  view,
  capabilities,
  admin,
  loading = false,
  active,
  onReload,
  onBack,
  onSaved,
  onFailure,
  conversationId,
  conversationTitle,
  onDirtyChange,
  onBusyChange,
  project,
  projectSettings,
  beforeManageNavigate,
  viewer,
  projectCapabilities,
}: {
  view: View;
  viewer?: Viewer;
  projectCapabilities?: ProjectCapabilities | null;
  beforeManageNavigate?: () => boolean;
  project?: CloudProjectDetail;
  projectSettings?: ReactNode;
  capabilities: CloudCapabilities | null;
  admin: boolean;
  loading?: boolean;
  /** The model currently selected in the composer, shown as "In use". */
  active?: { gatewayId: string; modelId: string };
  onReload?: () => void;
  onBack: () => void;
  onSaved: () => void;
  onFailure: (failure: unknown) => void;
  conversationId: string | null;
  conversationTitle?: string;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [extensionsBusy, setExtensionsBusy] = useState(false);
  const busy = memoryBusy || policyBusy || extensionsBusy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    onDirtyChange?.(memoryDirty || policyDirty);
    return () => onDirtyChange?.(false);
  }, [memoryDirty, policyDirty, onDirtyChange]);
  const { title, description } = titles[view];
  const unavailable = !capabilities;
  const management = manageDestination({ viewer, admin, project, projectCapabilities });
  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 sm:px-8 lg:px-12">
      <div className="mx-auto w-full max-w-3xl pb-12">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3 mb-7 text-xs text-muted-foreground"
          disabled={busy}
          onClick={onBack}
        >
          <ArrowLeftIcon />
          Back to conversation
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-6">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
          {view === "settings" && management && (
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <Link href={management.href} onClick={event => {
                if (beforeManageNavigate && !beforeManageNavigate()) event.preventDefault();
              }}>
                {management.label}
                <ArrowUpRightIcon aria-hidden />
              </Link>
            </Button>
          )}
          {view === "providers" && admin && (
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <Link href="/work?section=providers">
                {viewer?.organization.kind === "personal"
                  ? "Manage providers"
                  : "Manage organization providers"}
                <ArrowUpRightIcon aria-hidden />
              </Link>
            </Button>
          )}
        </div>
        {view === "plugins" ? (
          <CloudExtensions
            projectId={project?.id}
            readOnly={!!project && !(admin || project.access.actions.includes("connections.manage"))}
            onFailure={onFailure}
            onBusyChange={setExtensionsBusy}
          />
        ) : unavailable ? (
          <LoadState loading={loading} onReload={() => onReload?.()} />
        ) : view === "providers" ? (
          <div className="mt-6 space-y-6">
            {capabilities.providers.length ? (
              capabilities.providers.map((provider) => (
                <section
                  key={provider.gatewayId}
                  aria-label={provider.name}
                  className="overflow-hidden rounded-xl border border-border bg-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-5">
                    <div className="flex min-w-0 items-center gap-3">
                      <CatalogLogo id={provider.providerId} type="provider" />
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-semibold">
                          {provider.name}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {viewer?.organization.kind === "personal"
                            ? "Your connection"
                            : "Organization connection"}
                        </p>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-xs text-success-muted-foreground">
                      <CheckIcon aria-hidden className="size-3.5" />
                      Connected
                    </span>
                  </div>
                  <ProviderModels provider={provider} active={active} />
                </section>
              ))
            ) : (
              <Panel>
                <EmptyState
                  icon={ServerIcon}
                  title="No cloud providers are available"
                  description={
                    !capabilities.enabled
                      ? "Cloud Work is turned off for your account. Ask an administrator to review your Work access."
                      : admin
                        ? "Connect a provider key and choose its models in Manage Work."
                        : "Ask an administrator to connect a provider and allow its models."
                  }
                />
              </Panel>
            )}
            {capabilities.providers.length > 0 && (
              <p className="text-xs leading-5 text-muted-foreground">
                {viewer?.organization.kind === "personal"
                  ? "Your keys are encrypted on the server. Choose a model from the conversation composer."
                  : "Company keys stay on your organization's server. Choose a model from the conversation composer."}
              </p>
            )}
          </div>
        ) : (
          projectSettings ? <div className="mt-7 space-y-8"><NotificationSettings />{projectSettings}</div> : <div className="mt-7 space-y-8 [&>section]:border-b [&>section]:border-border/70 [&>section]:pb-8 [&>section:last-child]:border-0">
            <NotificationSettings />
            <AppearanceSettings />
            {capabilities.features.tools && <CloudApprovalControl />}
            <section
              aria-labelledby="cloud-availability-heading"
              className="space-y-3"
            >
              <h3
                id="cloud-availability-heading"
                className="text-sm font-semibold"
              >
                Availability
              </h3>
              <Panel className="border-0 bg-transparent [&>div]:px-0 [&>div]:first:pt-1">
                <SettingsRow
                  label="Cloud Work"
                  description={
                    capabilities.enabled
                      ? "Work is enabled for your account, so Cloud Work is available."
                      : "Work is turned off for your account, so Cloud Work is unavailable."
                  }
                  hint={
                    capabilities.enabled && !capabilities.available
                      ? "Waiting for the worker to come online"
                      : undefined
                  }
                >
                  <Badge variant={capabilities.enabled ? "success" : "outline"}>
                    {capabilities.enabled ? "On" : "Off"}
                  </Badge>
                </SettingsRow>
                <div className="border-t border-border/60 [&>div]:px-0">
                  <SettingsRow
                    label="Where work runs"
                    description="Enterprise Cloud runs on your organization's server using files attached to each conversation. Local conversations and device folders stay in the desktop application."
                  >
                    <span />
                  </SettingsRow>
                </div>
              </Panel>
              <p className="text-xs leading-5 text-muted-foreground">
                Access, providers, tools, and models are managed in{" "}
                {admin ? (
                  <Link href="/work" className="underline underline-offset-4">
                    Work access
                  </Link>
                ) : (
                  "Work access by your administrator"
                )}
                .
              </p>
            </section>
            {admin && (
              <CloudSettings
                onSaved={onSaved}
                onFailure={onFailure}
                onDirtyChange={setPolicyDirty}
                onBusyChange={setPolicyBusy}
              />
            )}
            {capabilities.enabled && capabilities.features.memory ? (
              <CloudMemory
                conversationId={conversationId}
                conversationTitle={conversationTitle}
                onFailure={onFailure}
                onDirtyChange={setMemoryDirty}
                onBusyChange={setMemoryBusy}
              />
            ) : (
              <section
                aria-labelledby="cloud-memory-off-heading"
                className="space-y-3"
              >
                <h3
                  id="cloud-memory-off-heading"
                  className="text-sm font-semibold"
                >
                  Memory
                </h3>
                <Panel>
                  <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">
                    {!capabilities.enabled
                      ? "Memory is available once Work is enabled for your account."
                      : "Your organization has turned off memory for your account."}
                  </p>
                </Panel>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <section aria-labelledby="cloud-appearance-heading" className="space-y-4">
      <div>
        <h3 id="cloud-appearance-heading" className="text-sm font-semibold">
          Appearance
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Choose a theme, or follow your device settings.
        </p>
      </div>
      <div
        role="group"
        aria-label="Color theme"
        className="grid max-w-md grid-cols-3 gap-2"
      >
        {(
          [
            { id: "light", label: "Light", Icon: SunIcon },
            { id: "dark", label: "Dark", Icon: MoonIcon },
            { id: "system", label: "System", Icon: LaptopIcon },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            disabled={!ready}
            aria-pressed={ready && theme === id}
            onClick={() => setTheme(id)}
            className={cn(
              "flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none",
              ready && theme === id
                ? "border-foreground/30 bg-secondary font-medium text-foreground"
                : "border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
