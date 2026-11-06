"use client";

import type { UsageAnalyticsBreakdown } from "@lori-enterprise/contracts";
import {
  CalendarDaysIcon,
  ChevronDownIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type UsageRangePreset = "7d" | "30d" | "90d" | "1y" | "all" | "custom";

const RANGE_LABELS: Record<UsageRangePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "1y": "Last 12 months",
  all: "All time",
  custom: "Custom range",
};

function optionLabel(items: UsageAnalyticsBreakdown[], id: string, fallback: string) {
  return items.find((item) => item.id === id)?.label ?? fallback;
}

export function UsageToolbar({
  agent,
  agentLabel = "Agent",
  agents,
  from,
  model,
  models,
  onChange,
  preset,
  to,
}: {
  agent: string;
  agentLabel?: string;
  agents: UsageAnalyticsBreakdown[];
  from: string;
  model: string;
  models: UsageAnalyticsBreakdown[];
  onChange(changes: Record<string, string | undefined>): void;
  preset: UsageRangePreset;
  to: string;
}) {
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);

  useEffect(() => {
    setCustomFrom(from);
    setCustomTo(to);
  }, [from, to]);

  const activeFilters = Number(Boolean(agent)) + Number(Boolean(model));
  const filterSummary = useMemo(() => {
    if (!activeFilters) return "All activity";
    if (activeFilters === 2) return "2 filters";
    return agent
      ? optionLabel(agents, agent, agent)
      : optionLabel(models, model, model);
  }, [activeFilters, agent, agents, model, models]);
  const invalidCustomRange = !customFrom || !customTo || customFrom > customTo;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={`Date range: ${RANGE_LABELS[preset]}`} variant="outline">
              <CalendarDaysIcon />
              {RANGE_LABELS[preset]}
              <ChevronDownIcon className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>Date range</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                const next = value as UsageRangePreset;
                onChange({
                  from: next === "custom" ? from : undefined,
                  range: next,
                  to: next === "custom" ? to : undefined,
                });
              }}
              value={preset}
            >
              {(Object.keys(RANGE_LABELS) as UsageRangePreset[]).map((range) => (
                <DropdownMenuRadioItem key={range} value={range}>
                  {RANGE_LABELS[range]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label={`Filters: ${filterSummary}`} variant="outline">
              <SlidersHorizontalIcon />
              <span className="max-w-40 truncate">{filterSummary}</span>
              {activeFilters ? (
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {activeFilters}
                </span>
              ) : (
                <ChevronDownIcon className="text-muted-foreground" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72">
            <DropdownMenuLabel>{agentLabel}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(value) => onChange({ agent: value || undefined })}
              value={agent}
            >
              <DropdownMenuRadioItem value="">{agentLabel === "Activity" ? "All activity" : "All agents"}</DropdownMenuRadioItem>
              {agents.map((item) => (
                <DropdownMenuRadioItem key={item.id} value={item.id}>
                  <span className="truncate" title={item.label}>{item.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(value) => onChange({ model: value || undefined })}
              value={model}
            >
              <DropdownMenuRadioItem value="">All models</DropdownMenuRadioItem>
              {models.map((item) => (
                <DropdownMenuRadioItem key={item.id} value={item.id}>
                  <span className="truncate" title={item.label}>{item.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {activeFilters ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-muted-foreground"
                  onSelect={() => onChange({ agent: undefined, model: undefined })}
                >
                  <XIcon className="size-4" />
                  Clear filters
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {preset === "custom" ? (
        <div className="grid gap-3 rounded-lg border border-border bg-card p-3 sm:max-w-xl sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="usage-from">From (UTC)</Label>
            <Input
              id="usage-from"
              max={customTo}
              onChange={(event) => setCustomFrom(event.target.value)}
              type="date"
              value={customFrom}
            />
          </div>
          <div>
            <Label htmlFor="usage-to">To (UTC)</Label>
            <Input
              id="usage-to"
              min={customFrom}
              onChange={(event) => setCustomTo(event.target.value)}
              type="date"
              value={customTo}
            />
          </div>
          <Button
            disabled={invalidCustomRange}
            onClick={() => onChange({ from: customFrom, range: "custom", to: customTo })}
            size="sm"
          >
            Apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}
