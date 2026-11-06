"use client";

import type {
  MemberUsageVisibility,
  UsageAnalyticsBreakdown,
  UsageAnalyticsMembersResponse,
  UsageAnalyticsResponse,
  UsageAnalyticsSettings,
  Viewer,
} from "@lori-enterprise/contracts";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowDownToLineIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  Clock3Icon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel, Section, SettingsRow } from "@/components/ui/section";
import { Select, SelectWrapper } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { isAdministrator } from "@/lib/authority";
import { ClientApiError, clientApi } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { formatCoveredCost, formatEstimatedCost, formatLocalDateTime, formatTokens } from "@/lib/usage-format";
import { UsageChart } from "./usage-chart";
import { UsageToolbar, type UsageRangePreset } from "./usage-toolbar";

type Preset = UsageRangePreset;
type View = "overview" | "members" | "settings";

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function presetRange(preset: Preset): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  const days = preset === "7d" ? 6 : preset === "90d" ? 89 : preset === "1y" ? 364 : 29;
  if (preset === "all") return { from: "2000-01-01", to: utcDate(to) };
  from.setUTCDate(from.getUTCDate() - days);
  return { from: utcDate(from), to: utcDate(to) };
}

function errorMessage(error: unknown): string {
  if (error instanceof ClientApiError) {
    if (error.status === 401) return "Your session expired. Sign in again, then return to Usage.";
    if (error.status === 403) return "You no longer have permission to view this usage scope.";
    if (error.status === 429) return "Too many analytics requests were made. Wait a moment and retry.";
    return error.message;
  }
  return "Usage analytics could not be loaded. Check your connection and retry.";
}

function comparisonLabel(value: number | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value === 0) return "No change from prior period";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}% from prior period`;
}

function mergeBreakdowns(
  current: UsageAnalyticsBreakdown[],
  incoming: UsageAnalyticsBreakdown[],
): UsageAnalyticsBreakdown[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return Array.from(merged.values()).sort((a, b) => a.label.localeCompare(b.label));
}

const subscribeToViewerTimeZone = () => () => undefined;
const serverTimeZoneSnapshot = () => null;

function useViewerTimeZone(): string | null {
  return useSyncExternalStore(
    subscribeToViewerTimeZone,
    () => new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    serverTimeZoneSnapshot,
  );
}

function LocalDateTime({ value }: { value?: string }) {
  const timeZone = useViewerTimeZone();
  if (!value) return <>Not received yet</>;
  return (
    <time dateTime={value} title={timeZone ?? undefined}>
      {timeZone ? formatLocalDateTime(value, { timeZone }) : "Loading local time…"}
    </time>
  );
}

function Breakdown({
  costCoveragePercent,
  dimension,
  items,
  metric,
  title,
  product = "code",
}: {
  product?: "code" | "work";
  costCoveragePercent: number;
  dimension: "agent" | "model";
  items: UsageAnalyticsBreakdown[];
  metric: "tokens" | "cost";
  title: string;
}) {
  const costAvailable = costCoveragePercent > 0;
  const useCost =
    metric === "cost" &&
    costAvailable &&
    items.some((item) => item.estimatedCostMicrousd > 0);
  const valueFor = (item: UsageAnalyticsBreakdown) =>
    useCost ? item.estimatedCostMicrousd : item.totalTokens;
  const total = items.reduce((sum, item) => sum + valueFor(item), 0);
  const max = Math.max(...items.map(valueFor), 1);
  return (
    <Section
      description={`Usage share with tokens, ${product === "work" ? "model requests" : "turns"}, and estimated cost for the selected range.`}
      title={title}
    >
      <Panel>
        {items.length ? (
          <ol className="divide-y divide-border">
            {items.slice(0, 8).map((item, index) => {
              const share = total > 0 ? valueFor(item) / total * 100 : 0;
              const notReported = item.id === "unknown";
              const itemCoverage = item.costCoveragePercent ?? (item.estimatedCostMicrousd > 0 ? 100 : 0);
              const itemCostAvailable = product === "work" ? itemCoverage > 0 : costAvailable;
              const itemCost = product === "work" ? formatCoveredCost({ ...item, costCoveragePercent: itemCoverage }) : formatEstimatedCost(item.estimatedCostMicrousd);
              const costLabel = itemCostAvailable
                ? `estimated cost ${itemCost}`
                : "estimated cost unavailable";
              return (
                <li
                  aria-label={`${item.label}: ${formatTokens(item.totalTokens)} tokens, ${formatTokens(item.totalTurns)} ${product === "work" ? (item.totalTurns === 1 ? "request" : "requests") : (item.totalTurns === 1 ? "turn" : "turns")}, ${costLabel}`}
                  className="px-4 py-3.5 sm:px-5"
                  key={item.id}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        aria-hidden
                        className="mt-0.5 w-4 shrink-0 text-xs tabular-nums text-muted-foreground"
                      >
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p
                          className="truncate text-sm font-medium text-foreground"
                          title={item.label}
                        >
                          {item.label}
                        </p>
                        {notReported ? (
                          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                            {dimension === "model"
                              ? "Model metadata was not included for this usage."
                              : "Agent metadata was not included for this usage."}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <p className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      <span className="block font-medium text-foreground">
                        {share < 0.1 && share > 0 ? "<0.1" : share.toFixed(1)}%
                      </span>
                      of usage
                    </p>
                  </div>
                  <div
                    aria-hidden
                    className="ml-7 mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                      style={{
                        width: `${Math.max(2, (valueFor(item) / max) * 100)}%`,
                      }}
                    />
                  </div>
                  <dl className="ml-7 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                    <div className="flex gap-1">
                      <dt className="sr-only">Tokens</dt>
                      <dd>
                        <span className="font-medium text-foreground">
                          {formatTokens(item.totalTokens)}
                        </span>{" "}
                        tokens
                      </dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="sr-only">{product === "work" ? "Requests" : "Turns"}</dt>
                      <dd>
                        <span className="font-medium text-foreground">
                          {formatTokens(item.totalTurns)}
                        </span>{" "}
                        {product === "work" ? (item.totalTurns === 1 ? "request" : "requests") : (item.totalTurns === 1 ? "turn" : "turns")}
                      </dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="sr-only">Estimated cost</dt>
                      <dd>
                        {itemCostAvailable ? (
                          <>
                            Est.{" "}
                            <span className="font-medium text-foreground">
                              {itemCost}
                            </span>
                          </>
                        ) : (
                          "Cost unavailable"
                        )}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No {title.toLowerCase()} were recorded in this range.
          </p>
        )}
      </Panel>
    </Section>
  );
}

function LoadingState() {
  return <div aria-label="Loading usage analytics" className="space-y-6"><div className="h-24 animate-pulse rounded-lg bg-muted" /><div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(17rem,0.72fr)]"><div className="h-[25rem] animate-pulse rounded-lg bg-muted" /><div className="h-[25rem] animate-pulse rounded-lg bg-muted" /></div><div className="grid gap-6 lg:grid-cols-2"><div className="h-44 animate-pulse rounded-lg bg-muted" /><div className="h-44 animate-pulse rounded-lg bg-muted" /></div></div>;
}

function TokenComposition({ analytics }: { analytics: UsageAnalyticsResponse }) {
  const composition = [
    ["Input", analytics.totals.inputTokens, "bg-primary"],
    ["Output", analytics.totals.outputTokens, "bg-foreground/75"],
    ["Cache read", analytics.totals.cacheReadTokens, "bg-success"],
    ["Cache write", analytics.totals.cacheWriteTokens, "bg-warning"],
  ] as const;
  return (
    <Panel className="h-full p-5">
      <h2 className="text-sm font-semibold text-foreground">Token mix</h2>
      <p className="mt-1 text-xs text-muted-foreground">How the selected usage is composed.</p>
      <div className="mt-6 flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        {composition.map(([label, value, color]) => (
          <div
            className={cn(color, "transition-[width] duration-200 motion-reduce:transition-none")}
            key={label}
            style={{ width: `${analytics.totals.totalTokens ? value / analytics.totals.totalTokens * 100 : 0}%` }}
          />
        ))}
      </div>
      <dl className="mt-5 divide-y divide-border">
        {composition.map(([label, value, color]) => (
          <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0" key={label}>
            <dt className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className={cn("size-2 rounded-full", color)} aria-hidden />
              {label}
            </dt>
            <dd className="text-right">
              <span className="block text-sm font-medium tabular-nums text-foreground">{formatTokens(value)}</span>
              <span className="block text-[11px] tabular-nums text-muted-foreground">
                {analytics.totals.totalTokens ? `${(value / analytics.totals.totalTokens * 100).toFixed(1)}%` : "0%"}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function AnalyticsView({
  analytics,
  hasFilters,
  metric,
  onMetricChange,
  product,
}: {
  product: "code" | "work";
  analytics: UsageAnalyticsResponse;
  hasFilters: boolean;
  metric: "tokens" | "cost";
  onMetricChange(metric: "tokens" | "cost"): void;
}) {
  const summary = [
    { change: analytics.comparison?.totalTokensPercent, label: "Total tokens", value: formatTokens(analytics.totals.totalTokens) },
    { change: product === "work" && analytics.totals.costCoveragePercent < 100 ? undefined : analytics.comparison?.estimatedCostPercent, label: "Estimated cost", value: product === "work" ? formatCoveredCost(analytics.totals) : formatEstimatedCost(analytics.totals.estimatedCostMicrousd) },
    { change: analytics.comparison?.totalTurnsPercent, label: product === "work" ? "Model requests" : "Turns", value: formatTokens(analytics.totals.totalTurns) },
    ...(analytics.scope.type === "organization" ? [{ label: "Active members", value: formatTokens(analytics.totals.activeMembers) }] : []),
  ];
  return (
    <div className="space-y-7">
      {!analytics.collectionEnabled ? <Alert><strong>Collection is disabled.</strong> No new desktop or Cloud Work usage is being collected. Previously retained history remains available to administrators.</Alert> : null}
      {analytics.totals.totalTokens > 0 && analytics.totals.costCoveragePercent < 100 ? <Alert variant="warning"><strong>{analytics.totals.costCoveragePercent === 0 ? "Pricing is unavailable." : "Estimated cost is partial."}</strong> Pricing covered {analytics.totals.costCoveragePercent.toFixed(1)}% of tokens in this result. Unpriced tokens are excluded from the estimate, never counted as free usage.</Alert> : null}
      <div className={cn("grid grid-cols-2 border-y border-border", analytics.scope.type === "organization" ? "xl:grid-cols-4" : "xl:grid-cols-3")}>
        {summary.map(({ change, label, value }, index) => <div className={cn("px-3 py-4 sm:px-5", index < 2 && "border-b border-border xl:border-b-0", index % 2 === 1 && "border-l border-border", index === 2 && "xl:border-l xl:border-border")} key={label}><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-[-0.025em] text-foreground">{value}</p>{comparisonLabel(change) ? <p className="mt-1 text-xs text-muted-foreground">{comparisonLabel(change)}</p> : <p className="mt-1 text-xs text-muted-foreground">Selected period</p>}</div>)}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(17rem,0.72fr)]">
        <Panel>
          <UsageChart
            emptyDescription={hasFilters ? "Clear the agent or model filter to widen the result." : analytics.collectionEnabled ? (product === "work" ? "Use Work on an enrolled Lori desktop or in Enterprise Cloud. Reported model usage appears after collection." : "Connect an enrolled Lori desktop and use a supported coding agent. The first aggregate will appear after sync.") : "Collection is off. Previously retained usage appears here when the selected period contains data."}
            emptyTitle={hasFilters ? "No usage matches these filters" : analytics.collectionEnabled ? "Awaiting usage data" : "No retained usage in this range"}
            metric={metric}
            onMetricChange={onMetricChange}
            points={analytics.series}
          />
        </Panel>
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-1">
          <TokenComposition analytics={analytics} />
          <Panel className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Data health</h2>
                <p className="mt-1 text-xs text-muted-foreground">Freshness and estimate quality.</p>
              </div>
              <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden />
            </div>
            <dl className="mt-5 divide-y divide-border">
              <div className="py-3 first:pt-0">
                <dt className="text-xs text-muted-foreground">Desktop sync</dt>
                <dd className="mt-1 flex items-center gap-2 text-sm font-medium text-foreground"><Clock3Icon className="size-3.5 text-muted-foreground" />{analytics.freshness.stale ? "Stale" : analytics.freshness.lastReceivedAt ? "Current" : "Awaiting first sync"}</dd>
                <dd className="mt-1 text-xs text-muted-foreground"><LocalDateTime value={analytics.freshness.lastReceivedAt} /></dd>
              </div>
              <div className="py-3 last:pb-0">
                <dt className="text-xs text-muted-foreground">Estimated cost coverage</dt>
                <dd className="mt-1 text-sm font-medium tabular-nums text-foreground">{analytics.totals.totalTokens ? `${analytics.totals.costCoveragePercent.toFixed(1)}%` : "Not available"}</dd>
                <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">Based only on tokens with recognized pricing.</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-2"><Breakdown product={product} costCoveragePercent={analytics.totals.costCoveragePercent} dimension="agent" items={analytics.agents} metric={metric} title={product === "work" ? "Activity" : "Agents"} /><Breakdown product={product} costCoveragePercent={analytics.totals.costCoveragePercent} dimension="model" items={analytics.models} metric={metric} title="Models" /></div>
    </div>
  );
}

function MembersView({ from, onDrillDown, to, product }: { from: string; onDrillDown(memberId: string): void; to: string; product: "code" | "work" }) {
  const requestGeneration = useRef(0);
  const [data, setData] = useState<UsageAnalyticsMembersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"tokens" | "cost" | "activity">("tokens");
  const [offset, setOffset] = useState(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++requestGeneration.current;
    setError(null);
    setData(null);
    try {
      const params = new URLSearchParams({ from, limit: "50", offset: String(offset), q: query, sort, to, product });
      const next = await clientApi<UsageAnalyticsMembersResponse>(`/v1/admin/usage/members?${params}`, { signal });
      if (generation === requestGeneration.current && !signal?.aborted) setData(next);
    } catch (cause) {
      if (generation === requestGeneration.current && !signal?.aborted && !(cause instanceof ClientApiError && cause.code === "request_cancelled")) {
        setError(errorMessage(cause));
      }
    }
  }, [from, offset, product, query, sort, to]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 200);
    return () => {
      ++requestGeneration.current;
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);
  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="w-full max-w-sm"><Label htmlFor="member-search">Search members</Label><div className="relative mt-1.5"><SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="member-search" className="pl-9" onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="Name or email" value={query} /></div></div>
      <SelectWrapper className="w-full sm:w-44"><Select aria-label="Sort members" onChange={(event) => { setSort(event.target.value as typeof sort); setOffset(0); }} value={sort}><option value="tokens">Most tokens</option><option value="cost">Highest cost</option><option value="activity">Recent activity</option></Select></SelectWrapper>
    </div>
    {error ? <Alert variant="destructive"><AlertCircleIcon />{error}<Button className="ml-auto" onClick={() => void load()} size="sm" variant="outline"><RefreshCwIcon />Retry</Button></Alert> : null}
    <Panel><div className="overflow-x-auto"><table className="w-full min-w-[960px] text-left text-sm"><caption className="sr-only">Members ranked by organization usage.</caption><thead><tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground"><th className="px-5 py-3 font-medium" scope="col">Member</th><th className="px-4 py-3 text-right font-medium" scope="col">Tokens</th><th className="px-4 py-3 text-right font-medium" scope="col">Estimated cost</th><th className="px-4 py-3 text-right font-medium" scope="col">{product === "work" ? "Requests" : "Turns"}</th><th className="px-4 py-3 font-medium" scope="col">Last activity</th><th className="px-4 py-3 font-medium" scope="col">Visibility</th><th className="px-5 py-3" scope="col"><span className="sr-only">Action</span></th></tr></thead><tbody>{data?.members.map((member) => <tr className="border-b border-border transition-colors last:border-0 hover:bg-muted/30" key={member.id}><th className="px-5 py-3.5 text-left font-normal" scope="row"><p className="font-medium text-foreground">{member.label}</p>{member.email ? <p className="text-xs text-muted-foreground">{member.email}</p> : null}</th><td className="px-4 py-3.5 text-right tabular-nums">{formatTokens(member.totalTokens)}</td><td className="px-4 py-3.5 text-right tabular-nums">{product === "work" ? formatCoveredCost({ ...member, costCoveragePercent: member.costCoveragePercent ?? (member.estimatedCostMicrousd > 0 ? 100 : 0) }) : formatEstimatedCost(member.estimatedCostMicrousd)}</td><td className="px-4 py-3.5 text-right tabular-nums">{formatTokens(member.totalTurns)}</td><td className="px-4 py-3.5 text-xs text-muted-foreground">{member.lastReceivedAt ? <LocalDateTime value={member.lastReceivedAt} /> : "No activity"}</td><td className="px-4 py-3.5"><Badge variant={member.visibility === "shown" ? "success" : "secondary"}>{member.visibility === "former" ? "Former" : member.visibility === "shown" ? "Shown" : "Hidden"}</Badge></td><td className="px-5 py-3.5 text-right">{member.memberId ? <Button aria-label={`View ${member.label} usage`} onClick={() => onDrillDown(member.memberId!)} size="sm" variant="ghost">View<ArrowRightIcon /></Button> : null}</td></tr>)}</tbody></table></div>{data && data.members.length === 0 ? <p className="px-5 py-10 text-center text-sm text-muted-foreground">No members match this search.</p> : null}</Panel>
    {data ? <div className="flex items-center justify-between"><p className="text-xs text-muted-foreground">{data.pageInfo.total} members and groups</p><div className="flex gap-2"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} size="sm" variant="outline">Previous</Button><Button disabled={!data.pageInfo.hasMore} onClick={() => setOffset(offset + 50)} size="sm" variant="outline">Next</Button></div></div> : <div className="h-56 animate-pulse rounded-lg bg-muted" />}
  </div>;
}

function SettingsView() {
  const [settings, setSettings] = useState<UsageAnalyticsSettings | null>(null);
  const [draft, setDraft] = useState<UsageAnalyticsSettings | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");
  const load = useCallback(async () => {
    try { const next = await clientApi<UsageAnalyticsSettings>("/v1/admin/usage/settings"); setSettings(next); setDraft(next); }
    catch (cause) { setFeedback({ kind: "error", message: errorMessage(cause) }); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function save() {
    if (!draft || !settings) return;
    setSaving(true); setFeedback(null);
    try {
      const next = await clientApi<UsageAnalyticsSettings>("/v1/admin/usage/settings", { method: "PATCH", body: JSON.stringify({ collectionEnabled: draft.collectionEnabled, expectedRevision: settings.revision, memberVisibilityDefault: draft.memberVisibilityDefault, retentionDays: draft.retentionDays }) });
      setSettings(next); setDraft(next); setFeedback({ kind: "success", message: "Usage analytics settings were saved." });
    } catch (cause) { setFeedback({ kind: "error", message: errorMessage(cause) }); }
    finally { setSaving(false); }
  }
  async function deleteAll() {
    if (confirmDelete !== "DELETE USAGE" || !settings) return;
    setSaving(true); setFeedback(null);
    try { await clientApi("/v1/admin/usage", { method: "DELETE", body: JSON.stringify({ expectedRevision: settings.revision }) }); setConfirmDelete(""); setFeedback({ kind: "success", message: "Organization usage history was deleted and collection identity was rotated." }); await load(); }
    catch (cause) { setFeedback({ kind: "error", message: errorMessage(cause) }); }
    finally { setSaving(false); }
  }
  if (!draft) return <LoadingState />;
  return <div className="space-y-8">
    {feedback ? <Alert variant={feedback.kind === "error" ? "destructive" : "success"}>{feedback.kind === "success" ? <CheckCircle2Icon /> : <AlertCircleIcon />}{feedback.message}</Alert> : null}
    <Section description="Collection and member visibility are separate. Hiding a member view does not stop administrative collection." title="Collection and visibility"><Panel className="divide-y divide-border"><SettingsRow description="Collect daily token and estimated-cost aggregates from enrolled Lori desktops and Enterprise Cloud Work." label="Collect usage analytics"><Toggle aria-label="Collect usage analytics" checked={draft.collectionEnabled} disabled={saving} onChange={(collectionEnabled) => setDraft({ ...draft, collectionEnabled })} /></SettingsRow><SettingsRow description="Members inherit this setting unless an administrator sets Show or Hide for that person." label="Show personal usage to members"><Toggle aria-label="Show personal usage to members" checked={draft.memberVisibilityDefault} disabled={saving} onChange={(memberVisibilityDefault) => setDraft({ ...draft, memberVisibilityDefault })} /></SettingsRow><SettingsRow description="Lifetime keeps aggregates until an administrator deletes them. Shorter retention applies immediately to results and cleanup runs in the background." label="Retention"><SelectWrapper className="w-full sm:w-48"><Select aria-label="Usage retention" disabled={saving} onChange={(event) => setDraft({ ...draft, retentionDays: event.target.value === "lifetime" ? null : Number(event.target.value) as 30 | 90 | 180 | 365 })} value={draft.retentionDays ?? "lifetime"}><option value="lifetime">Lifetime</option><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days</option></Select></SelectWrapper></SettingsRow></Panel><div className="mt-4 flex justify-end"><Button disabled={saving || JSON.stringify(draft) === JSON.stringify(settings)} onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</Button></div></Section>
    <Section description="Lori uploads only aggregate counters. Prompts, responses, tool arguments, file paths, project or session names, credentials, and provider endpoints are never included." title="Privacy boundary"><Panel className="p-5 text-sm leading-relaxed text-muted-foreground">Usage is grouped by UTC date, coding agent, and normalized model. Monetary values are estimates and include explicit pricing coverage.</Panel></Section>
    <Section description="This permanently removes retained organization usage, rotates the collection epoch, and prevents stale desktop snapshots and Cloud runs from restoring deleted history." title="Delete usage history"><Panel className="p-5"><Label htmlFor="delete-usage">Type DELETE USAGE to confirm</Label><div className="mt-2 flex flex-col gap-3 sm:flex-row"><Input id="delete-usage" onChange={(event) => setConfirmDelete(event.target.value)} value={confirmDelete} /><Button disabled={saving || confirmDelete !== "DELETE USAGE"} onClick={() => void deleteAll()} variant="destructive">Delete organization usage</Button></div></Panel></Section>
  </div>;
}

function MemberDeletion({ memberId, onDeleted }: { memberId: string; onDeleted(): void }) {
  const [confirmation, setConfirmation] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  async function removeHistory() {
    if (confirmation !== "DELETE MEMBER USAGE") return;
    setDeleting(true);
    setFeedback(null);
    try {
      const settings = await clientApi<UsageAnalyticsSettings>("/v1/admin/usage/settings");
      await clientApi("/v1/admin/usage", {
        body: JSON.stringify({ expectedRevision: settings.revision, memberId }),
        method: "DELETE",
      });
      setConfirmation("");
      setFeedback("This member’s usage was deleted and their collection identity was rotated.");
      onDeleted();
    } catch (cause) {
      setFeedback(errorMessage(cause));
    } finally {
      setDeleting(false);
    }
  }
  return (
    <Section
      description="This deletes only this active member’s retained aggregates. Organization totals are reduced, and stale desktop snapshots cannot restore the deleted history."
      title="Delete member usage"
    >
      <Panel className="p-5">
        {feedback ? <Alert className="mb-4">{feedback}</Alert> : null}
        <Label htmlFor="delete-member-usage">Type DELETE MEMBER USAGE to confirm</Label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <Input id="delete-member-usage" onChange={(event) => setConfirmation(event.target.value)} value={confirmation} />
          <Button disabled={deleting || confirmation !== "DELETE MEMBER USAGE"} onClick={() => void removeHistory()} variant="destructive">
            {deleting ? "Deleting…" : "Delete member usage"}
          </Button>
        </div>
      </Panel>
    </Section>
  );
}

export function UsageDashboard({ viewer, product = "code" }: { viewer: Viewer; product?: "code" | "work" }) {
  const requestGeneration = useRef(0);
  const visibilityGeneration = useRef(0);
  const currentScope = useRef("");
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const router = useRouter();
  const search = useSearchParams();
  const admin = isAdministrator(viewer);
  const requestedView = search.get("view");
  const view: View = admin && (requestedView === "members" || (requestedView === "settings" && product === "code")) ? requestedView : "overview";
  const requestedPreset = search.get("range");
  const preset: Preset = requestedPreset && ["7d", "30d", "90d", "1y", "all", "custom"].includes(requestedPreset)
    ? requestedPreset as Preset
    : "30d";
  const standardRange = presetRange(preset === "custom" ? "30d" : preset);
  const from = preset === "custom" && search.get("from") ? search.get("from")! : standardRange.from;
  const to = preset === "custom" && search.get("to") ? search.get("to")! : standardRange.to;
  const metric = search.get("metric") === "cost" ? "cost" : "tokens";
  const memberId = admin ? search.get("memberId") ?? undefined : undefined;
  currentScope.current = `${product}:${memberId ?? ""}`;
  const agent = search.get("agent") ?? "";
  const model = search.get("model") ?? "";
  const [analytics, setAnalytics] = useState<UsageAnalyticsResponse | null>(null);
  const [agentOptions, setAgentOptions] = useState<UsageAnalyticsBreakdown[]>([]);
  const [modelOptions, setModelOptions] = useState<UsageAnalyticsBreakdown[]>([]);
  const [visibility, setVisibility] = useState<MemberUsageVisibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef(search.toString());

  useEffect(() => {
    searchRef.current = search.toString();
  }, [search]);

  const replace = useCallback((changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchRef.current);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    searchRef.current = next.toString();
    router.replace(`${product === "work" ? "/work/usage" : "/usage"}?${searchRef.current}`, { scroll: false });
  }, [product, router]);
  const requestQuery = useMemo(() => {
    const params = new URLSearchParams({ from, to, product });
    if (agent) params.set("agent", agent);
    if (model) params.set("model", model);
    if (memberId) params.set("memberId", memberId);
    return params;
  }, [agent, from, memberId, model, product, to]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++requestGeneration.current;
    ++visibilityGeneration.current;
    setVisibilitySaving(false);
    if (view !== "overview") return;
    setLoading(true); setError(null); setAnalytics(null); setVisibility(null);
    try {
      const path = admin ? "/v1/admin/usage" : "/v1/usage";
      let next = await clientApi<UsageAnalyticsResponse>(`${path}?${requestQuery}`, { signal });
      if (product === "work") {
        const labels: Record<string, string> = { "work-agent": "Conversations", "work-text": "Text responses", "work-title": "Titles", "work-memory": "Memory", "work-summary": "Summaries" };
        next = { ...next, agents: next.agents.map(item => ({ ...item, label: labels[item.id] ?? item.label })) };
      }
      const nextVisibility = memberId
        ? await clientApi<MemberUsageVisibility>(`/v1/admin/usage/members/${encodeURIComponent(memberId)}/visibility`, { signal })
        : null;
      if (signal?.aborted || generation !== requestGeneration.current) return;
      setAnalytics(next);
      setAgentOptions((current) => mergeBreakdowns(current, next.agents));
      setModelOptions((current) => mergeBreakdowns(current, next.models));
      setVisibility(nextVisibility);
    } catch (cause) { if (generation === requestGeneration.current && !signal?.aborted && !(cause instanceof ClientApiError && cause.code === "request_cancelled")) setError(errorMessage(cause)); }
    finally { if (generation === requestGeneration.current && !signal?.aborted) setLoading(false); }
  }, [admin, memberId, product, requestQuery, view]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => { ++requestGeneration.current; ++visibilityGeneration.current; controller.abort(); }; }, [load]);
  async function updateVisibility(override: "inherit" | "show" | "hide") {
    if (!memberId) return;
    if (!visibility) return;
    if (visibilitySaving) return;
    const scope = currentScope.current;
    const generation = ++visibilityGeneration.current;
    setVisibilitySaving(true);
    try {
      const next = await clientApi<MemberUsageVisibility>(`/v1/admin/usage/members/${encodeURIComponent(memberId)}/visibility`, { method: "PATCH", body: JSON.stringify({ expectedRevision: visibility.revision, override }) });
      if (scope === currentScope.current && generation === visibilityGeneration.current) setVisibility(next);
    }
    catch (cause) { if (scope === currentScope.current && generation === visibilityGeneration.current) setError(errorMessage(cause)); }
    finally { if (scope === currentScope.current && generation === visibilityGeneration.current) setVisibilitySaving(false); }
  }
  const exportHref = `/api/${admin ? "v1/admin/usage" : "v1/usage"}/export.csv?${requestQuery}`;
  return <div className="space-y-8">
    {product === "work" ? <div className="flex flex-wrap gap-4 text-sm"><Link className="underline underline-offset-4" href="/work">Work access</Link>{admin ? <Link className="underline underline-offset-4" href="/usage?view=settings">Organization collection settings</Link> : null}</div> : null}
    <PageHeader actions={view === "overview" ? <Link className={buttonVariants({ variant: "outline" })} href={exportHref}><ArrowDownToLineIcon />Export CSV</Link> : undefined} description={product === "work" ? "Work usage includes enrolled desktops and Enterprise Cloud. Only reported tokens are counted; costs are estimates." : admin ? "Understand where organization LLM usage is moving, then drill into members, agents, and models. Usage periods are UTC, sync times are local, and costs are estimates." : "Understand your LLM usage across enrolled Lori desktops. Usage periods are UTC, sync times are local, and costs are estimates."} title={memberId && analytics ? analytics.scope.name : product === "work" ? "Work usage" : "Usage analytics"} />
    {admin ? <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Usage sections">{(product === "work" ? ["overview", "members"] as const : ["overview", "members", "settings"] as const).map((item) => <button aria-selected={view === item} className={cn("min-h-11 border-b-2 px-3 text-sm font-medium transition-colors", view === item ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")} key={item} onClick={() => replace({ memberId: undefined, view: item === "overview" ? undefined : item })} role="tab" type="button">{item === "overview" ? "Overview" : item === "members" ? "Members" : "Settings"}</button>)}</div> : null}
    {view === "members" ? <MembersView product={product} from={from} onDrillDown={(id) => replace({ memberId: id, view: undefined })} to={to} /> : view === "settings" ? <SettingsView /> : <>
      {memberId ? <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between"><div><Button onClick={() => replace({ memberId: undefined })} size="sm" variant="ghost"><ArrowLeftIcon />Organization overview</Button>{visibility ? <p className="mt-2 text-xs text-muted-foreground">This member can <strong className="text-foreground">{visibility.effective ? "see" : "not see"}</strong> personal usage. Visibility is currently set to {visibility.override}.</p> : null}</div>{visibility ? <SelectWrapper className="w-full sm:w-44"><Select disabled={visibilitySaving} aria-label="Member usage visibility" onChange={(event) => void updateVisibility(event.target.value as "inherit" | "show" | "hide")} value={visibility.override}><option value="inherit">Inherit organization</option><option value="show">Show to member</option><option value="hide">Hide from member</option></Select></SelectWrapper> : null}</div> : null}
      <UsageToolbar
        agentLabel={product === "work" ? "Activity" : "Agent"}
        agent={agent}
        agents={agentOptions}
        from={from}
        model={model}
        models={modelOptions}
        onChange={replace}
        preset={preset}
        to={to}
      />
      {error ? <Alert variant="destructive"><AlertCircleIcon />{error}<Button className="ml-auto" onClick={() => void load()} size="sm" variant="outline"><RefreshCwIcon />Retry</Button></Alert> : null}
      {loading ? <LoadingState /> : analytics ? <AnalyticsView product={product} analytics={analytics} hasFilters={Boolean(agent || model)} metric={metric} onMetricChange={(next) => replace({ metric: next === "cost" ? "cost" : undefined })} /> : null}
      {product === "code" && memberId && !loading ? <MemberDeletion memberId={memberId} onDeleted={() => void load()} /> : null}
    </>}
  </div>;
}
