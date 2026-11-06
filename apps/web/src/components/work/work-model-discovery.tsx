"use client";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClientApiError } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { workApi } from "@/lib/work-api";
import { validWorkModelId } from "./work-provider-utils";

const CATEGORIES = [["chat", "Chat"], ["image", "Image"], ["video", "Video"], ["other", "Other"]] as const;
const REFERENCE_NOTES = {
  image: "Listed for reference. Work chat can't run image models yet.",
  video: "Listed for reference. Work chat can't run video models yet.",
  other: "Listed for reference. These models can't run in Work chat.",
};
const FAILURES = {
  key: "The provider refused this API key.",
  session: "Your session expired. Sign in again to load models.",
  denied: "Only organization administrators can load provider models.",
  rate: "Too many requests. Wait a minute, then refresh.",
  unavailable: "Couldn't load models from the provider.",
};
const VISIBLE_MODELS = 200;
const MODEL_LIMIT = 32;
const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const CHAT_COLUMNS = "@xl:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_4.5rem_4.5rem]";
const CELL = "hidden text-right text-xs tabular-nums text-muted-foreground @xl:block";

type Category = (typeof CATEGORIES)[number][0];
type Failure = keyof typeof FAILURES;
type Model = { id: string; name: string; context_length?: number; max_input_tokens?: number; max_output_tokens?: number; pricing?: { prompt?: number; completion?: number }; category?: Category; runsInWork?: boolean; unitPrice?: string };

function failureOf(reason: unknown): Failure {
  if (!(reason instanceof ClientApiError)) return "unavailable";
  if (reason.code === "work_provider_key_refused") return "key";
  if (reason.status === 401) return "session";
  if (reason.status === 403) return "denied";
  return reason.status === 429 ? "rate" : "unavailable";
}
const known = (value?: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const tokenLimit = (value?: number) => known(value) && value > 0 ? tokens.format(value) : "—";
const rate = (value?: number) => !known(value) ? "—" : value === 0 ? "Free" : usd.format(value * 1_000_000);
const contextOf = (model: Model) => model.context_length ?? model.max_input_tokens;
function summary(model: Model) {
  if (model.unitPrice) return model.unitPrice;
  const parts = [
    known(contextOf(model)) && `${tokenLimit(contextOf(model))} context`,
    known(model.max_output_tokens) && `${tokenLimit(model.max_output_tokens)} max output`,
    known(model.pricing?.prompt) && `${rate(model.pricing?.prompt)} input per 1M`,
    known(model.pricing?.completion) && `${rate(model.pricing?.completion)} output per 1M`,
  ];
  return parts.filter(Boolean).join(", ");
}
function compactSummary(model: Model) {
  const parts = [
    known(contextOf(model)) && `${tokenLimit(contextOf(model))} context`,
    (known(model.pricing?.prompt) || known(model.pricing?.completion)) && `${rate(model.pricing?.prompt)} / ${rate(model.pricing?.completion)} per 1M`,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function WorkModelDiscovery({ gatewayId, disabled, selected, automaticIds, onToggle, onUpdateKey, refreshKey }: {
  gatewayId: string;
  disabled: boolean;
  selected: readonly string[];
  /** Set when every model Work can run is on: there is nothing to choose, so rows are read-only. */
  automaticIds?: readonly string[];
  onToggle(id: string, allowed: boolean): void;
  onUpdateKey?(): void;
  refreshKey?: string;
}) {
  const [models, setModels] = useState<Model[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [category, setCategory] = useState<Category>("chat");
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set(selected));
  const [adding, setAdding] = useState(false);
  const [customId, setCustomId] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const latestSelected = useRef(selected);
  useEffect(() => { latestSelected.current = selected; }, [selected]);
  useEffect(() => { setModels(null); }, [gatewayId]);
  useEffect(() => {
    let active = true;
    setLoading(true); setFailure(null);
    void workApi<{ models: Model[] }>(`/v1/admin/work/provider-gateways/${encodeURIComponent(gatewayId)}/models`)
      .then((data) => {
        if (!Array.isArray(data.models)) throw new Error("Invalid model list");
        if (active) setModels(data.models.filter((m) => m && validWorkModelId(m.id) && typeof m.name === "string"));
      }).catch((reason) => { if (active) setFailure(failureOf(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [gatewayId, revision, refreshKey]);
  // Pinned order is a snapshot: ticking a row must not move it out from under the pointer.
  useEffect(() => {
    setPinned(new Set(latestSelected.current));
    if (list.current) list.current.scrollTop = 0;
  }, [models, category, query]);

  const listed = models ?? [];
  const typed = listed.some((m) => m.category);
  const term = query.trim().toLowerCase();
  const matches = (m: Model) => `${m.id} ${m.name}`.toLowerCase().includes(term);
  const isSelected = (id: string) => selected.includes(id);
  const custom: Model[] = selected.filter((id) => !listed.some((m) => m.id === id)).map((id) => ({ id, name: id }));
  const reference = typed && category !== "chat";
  const shown = [...custom.filter(() => !reference), ...listed.filter((m) => !typed || m.category === category || (category === "chat" && isSelected(m.id)))]
    .filter(matches)
    .map((m) => ({ model: m, rank: custom.includes(m) || pinned.has(m.id) ? 0 : m.runsInWork === false ? 2 : 1 }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ model }) => model);
  const full = selected.length >= MODEL_LIMIT;
  const automatic = automaticIds !== undefined;
  const locked = (m: Model) => automatic && m.runsInWork === true && !isSelected(m.id);
  const enabled = models
    ? new Set([...listed.filter((m) => automatic && m.runsInWork === true).map((m) => m.id), ...selected]).size
    : new Set([...(automaticIds ?? []), ...selected]).size;

  function closeCustom() { setAdding(false); setCustomId(""); setCustomError(null); }
  function addCustom() {
    const id = customId.trim();
    if (disabled) return;
    if (!validWorkModelId(id)) { setCustomError("Enter a model ID of 1 to 128 characters on one line."); return; }
    if (isSelected(id)) { setCustomError("This model is already added."); return; }
    if (full) { setCustomError(`You can add up to ${MODEL_LIMIT} models. Remove one first.`); return; }
    onToggle(id, true);
    closeCustom();
  }

  return <div className="@container space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Search models"
        className="min-w-40 flex-1 sm:h-9"
        placeholder="Search models"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
      />
      {typed && <div role="group" aria-label="Model type" className="flex shrink-0 flex-wrap gap-0.5">
        {CATEGORIES.filter(([id]) => listed.some((m) => m.category === id)).map(([id, label]) => {
          const count = listed.filter((m) => m.category === id && matches(m)).length;
          return <Button key={id} type="button" size="sm" variant={category === id ? "secondary" : "ghost"} aria-pressed={category === id} onClick={() => setCategory(id)}>
            {label} <span className="font-normal tabular-nums text-muted-foreground">{count}</span>
          </Button>;
        })}
      </div>}
      <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label="Refresh models" title="Refresh models" disabled={loading} onClick={() => setRevision((v) => v + 1)}>
        <RefreshCwIcon aria-hidden className={cn(loading && "animate-spin motion-reduce:animate-none")} />
      </Button>
    </div>
    {failure && <div role="alert" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{FAILURES[failure]}{models ? " Showing the last list." : " You can still add a custom model."}</span>
      {failure === "key" && onUpdateKey ? <Button type="button" size="sm" variant="outline" onClick={onUpdateKey}>Update key</Button>
        : failure === "session" ? <Button asChild size="sm" variant="outline"><a href="/sign-in" target="_blank" rel="noreferrer">Sign in again</a></Button>
          : failure === "unavailable" ? <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => setRevision((v) => v + 1)}>Retry</Button> : null}
    </div>}
    {reference && <p className="text-xs text-muted-foreground">{REFERENCE_NOTES[category as keyof typeof REFERENCE_NOTES]}</p>}
    <div className="overflow-hidden rounded-md border border-border bg-card">
      {models && shown.length > 0 && !reference && <div aria-hidden className={cn("hidden gap-3 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground @xl:grid", CHAT_COLUMNS)}>
        <span>Model</span><span className="text-right">Context</span><span className="text-right">Max output</span><span className="text-right">Input /1M</span><span className="text-right">Output /1M</span>
      </div>}
      {shown.length > 0
        ? <ul ref={list} aria-label="Provider models" className="max-h-80 divide-y divide-border overflow-y-auto overscroll-contain">
          {shown.slice(0, VISIBLE_MODELS).map((m) => {
            const checked = isSelected(m.id);
            const chat = !m.category || m.category === "chat";
            const selectable = checked || (chat && !automatic);
            const blocked = !checked && (m.runsInWork === false || full);
            const detail = summary(m);
            const compact = compactSummary(m);
            const row = <>
              <span className="flex min-w-0 items-center gap-2.5">
                {selectable && <input
                  type="checkbox"
                  aria-label={`Allow ${m.id}`}
                  aria-description={detail || undefined}
                  className="size-4 shrink-0 accent-primary"
                  checked={checked}
                  disabled={disabled || blocked}
                  onChange={(e) => onToggle(m.id, e.target.checked)}
                />}
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="break-all text-sm">{m.id}</span>
                    {models && custom.includes(m) && <Badge variant="secondary">Custom</Badge>}
                    {m.runsInWork === false && m.category === "chat" && <span className="text-xs text-muted-foreground">No tool calling</span>}
                  </span>
                  {chat && compact && <span aria-hidden className="block text-xs text-muted-foreground @xl:hidden">{compact}</span>}
                </span>
              </span>
              {chat ? models && <>
                <span aria-hidden className={CELL}>{tokenLimit(contextOf(m))}</span>
                <span aria-hidden className={CELL}>{tokenLimit(m.max_output_tokens)}</span>
                <span aria-hidden className={CELL}>{rate(m.pricing?.prompt)}</span>
                <span aria-hidden className={CELL}>{rate(m.pricing?.completion)}</span>
              </> : <span className="text-xs text-muted-foreground @xl:text-right">{m.unitPrice ?? `${rate(m.pricing?.prompt)} input /1M`}</span>}
            </>;
            const layout = cn("grid min-h-11 items-center gap-x-3 gap-y-0.5 px-3 py-2 sm:min-h-10", !chat ? "@xl:grid-cols-[minmax(0,1fr)_auto]" : models && CHAT_COLUMNS);
            return <li key={m.id} data-enabled={locked(m) || undefined}>
              {selectable
                ? <label className={cn(layout, "has-[:focus-visible]:bg-secondary/60", disabled || blocked ? "text-muted-foreground" : "cursor-pointer hover:bg-secondary/60")}>{row}</label>
                : <div className={cn(layout, automatic && !locked(m) && chat && "text-muted-foreground")}>{row}</div>}
            </li>;
          })}
        </ul>
        : <p role={loading ? "status" : undefined} className="px-3 py-8 text-center text-xs text-muted-foreground">
          {term ? `No ${reference ? `${category} ` : ""}models match “${query.trim()}”.`
            : loading ? "Loading models…"
              : models?.length && reference ? `No ${category} models.`
                : models ? "The provider returned no models."
                  : "No models to show yet."}
        </p>}
      {loading && !models && shown.length > 0 && <p role="status" className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Loading models…</p>}
      {shown.length > VISIBLE_MODELS && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Showing {VISIBLE_MODELS} of {shown.length}. Search to narrow the list.</p>}
      {adding
        ? <div className="space-y-2 border-t border-border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              autoFocus
              aria-label="Custom model ID"
              aria-invalid={customError ? true : undefined}
              className="min-w-40 flex-1 sm:h-8"
              maxLength={128}
              placeholder="Exact model ID from your provider"
              value={customId}
              onChange={(e) => { setCustomId(e.target.value); setCustomError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); addCustom(); }
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCustom(); }
              }}
            />
            <Button type="button" size="sm" disabled={disabled || !customId.trim()} onClick={addCustom}>Add model</Button>
            <Button type="button" size="sm" variant="ghost" onClick={closeCustom}>Cancel</Button>
          </div>
          {customError && <p role="alert" className="px-1 text-xs text-destructive">{customError}</p>}
        </div>
        : <div className="flex items-center justify-between gap-3 border-t border-border py-1 pl-3 pr-1">
          <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
            {automatic ? `${enabled} models enabled` : `${selected.length} of ${MODEL_LIMIT} selected`}
          </p>
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden />
            Add custom model
          </Button>
        </div>}
    </div>
    {full && !automatic && <p role="status" className="text-xs text-muted-foreground">Limit reached. Remove a model to add another.</p>}
  </div>;
}
