"use client";

import type { CloudApprovalMode, CloudMemberPreferences } from "@lori-enterprise/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon, Loader2Icon, LockKeyholeIcon, RotateCwIcon, ShieldCheckIcon, ShieldIcon } from "lucide-react";
import { cloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const CHANGED = "lori-cloud-approval-preference-changed";
const MODES: Record<CloudApprovalMode, { label: string; detail: string }> = {
  askMe: { label: "Ask me", detail: "Pause before file changes, commands and connected-tool actions, and wait for your approval." },
  approveForMe: { label: "Approve for me", detail: "Automatically approve permitted file changes, isolated commands and connected-tool actions." },
};
export function validateApprovalPreferences(value: CloudMemberPreferences): CloudMemberPreferences {
  if (!value || !["askMe", "approveForMe"].includes(value.approvalMode)
    || !["askMe", "approveForMe"].includes(value.effectiveApprovalMode)
    || typeof value.forcedAskMe !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.forcedAskMe ? value.effectiveApprovalMode !== "askMe" : value.effectiveApprovalMode !== value.approvalMode))
    throw new Error("The approval setting could not be loaded. Try again.");
  return value;
}

/** A member-owned preference; organization policy is displayed, never overridden. */
export function CloudApprovalControl({ compact = false, projectId }: { compact?: boolean; projectId?: string }) {
  const path = projectId ? `/projects/${projectId}/preferences` : "/preferences";
  const [preferences, setPreferences] = useState<CloudMemberPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const saving = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const hint = useId();
  const refresh = async () => {
    if (saving.current) return;
    const current = ++generation.current;
    try {
      const next = validateApprovalPreferences(await cloudApi<CloudMemberPreferences>(path));
      if (current !== generation.current) return;
      setPreferences(next); setError("");
    } catch (failure) {
      if (current !== generation.current) return;
      setPreferences(null); setError(cloudError(failure));
    }
  };
  useEffect(() => {
    void refresh();
    const reload = () => void refresh();
    window.addEventListener("focus", reload);
    window.addEventListener(CHANGED, reload);
    try {
      if (typeof BroadcastChannel !== "undefined") {
        channel.current = new BroadcastChannel(CHANGED);
        channel.current.onmessage = reload;
      }
    } catch { /* Same-page and focus refresh still work when messaging is blocked. */ }
    return () => {
      generation.current++;
      window.removeEventListener("focus", reload);
      window.removeEventListener(CHANGED, reload);
      channel.current?.close();
      channel.current = null;
    };
  }, [path]);
  const change = async (approvalMode: CloudApprovalMode) => {
    if (!preferences || saving.current || preferences.forcedAskMe || approvalMode === preferences.effectiveApprovalMode) return;
    const current = ++generation.current;
    saving.current = true; setBusy(true); setError("");
    try {
      const next = validateApprovalPreferences(await cloudApi<CloudMemberPreferences>(path,
        cloudMutation({ approvalMode, expectedRevision: preferences.revision }, "PATCH")));
      // No settings or identity data are broadcast; each surface reads its own authenticated preference.
      window.dispatchEvent(new Event(CHANGED));
      try {
        if (typeof BroadcastChannel !== "undefined") {
          const notification = new BroadcastChannel(CHANGED);
          notification.postMessage("changed");
          notification.close();
        }
      } catch { /* The setting is saved even if cross-tab messaging is unavailable. */ }
      if (current !== generation.current) return;
      setPreferences(next);
    } catch (failure) {
      if (current === generation.current) { setPreferences(null); setError(cloudError(failure)); }
    } finally {
      saving.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  const description = preferences?.forcedAskMe
    ? "Managed by your organization. Your organization requires Ask me for your account."
    : "Ask me pauses before changes. Approve for me automatically approves permitted file changes, isolated commands, and connected-tool actions. Applies to new actions; pending requests still need your decision.";
  const current = preferences?.effectiveApprovalMode;
  const locked = !!preferences?.forcedAskMe;
  const label = !preferences ? (error ? "Permissions unavailable" : "Loading…") : MODES[preferences.effectiveApprovalMode].label;
  const Icon = busy ? Loader2Icon : locked ? LockKeyholeIcon : current === "approveForMe" ? ShieldCheckIcon : ShieldIcon;
  const control = <div className="flex min-w-0 items-center gap-1">
    <span title={locked ? description : undefined} tabIndex={locked ? 0 : undefined}
      role={locked ? "group" : undefined} aria-label={locked ? description : undefined}
      className="inline-flex min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&_button:disabled]:pointer-events-none">
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!preferences || busy || locked}>
        <button type="button" aria-label="Approval mode" aria-describedby={hint} aria-busy={busy || undefined}
          title={locked ? description : undefined} disabled={!preferences || busy || locked}
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-md text-[var(--work-muted,var(--muted-foreground))] outline-none transition-colors hover:bg-[var(--work-hover,var(--secondary))] hover:text-[var(--work-ink,var(--foreground))] focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-[var(--work-hover,var(--secondary))] data-[state=open]:text-[var(--work-ink,var(--foreground))] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-[var(--work-muted,var(--muted-foreground))] motion-reduce:transition-none",
            compact ? "h-11 px-2 text-xs sm:h-8" : "h-9 border border-border bg-background px-3 text-sm",
          )}>
          <Icon aria-hidden className={cn("size-3.5 shrink-0", busy && "animate-spin motion-reduce:animate-none")} />
          <span className="truncate">{label}</span>
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? "top" : "bottom"} align="start" className="w-[min(20rem,calc(100vw-2rem))]">
        <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-[11px] font-normal text-muted-foreground">When Lori needs to change something</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current ?? ""} onValueChange={(value) => void change(value as CloudApprovalMode)}>
          {(Object.keys(MODES) as CloudApprovalMode[]).map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode} className="items-start py-2 sm:py-2 [&>span:first-child]:top-[11px]">
              <span className="min-w-0">
                <span className="block text-[13px] font-medium leading-5">{MODES[mode].label}</span>
                <span className="block text-xs leading-4 text-muted-foreground">{MODES[mode].detail}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-2 pb-1.5 pt-1 text-[11px] leading-4 text-muted-foreground">Applies to new actions. Requests already waiting still need your decision.</p>
      </DropdownMenuContent>
    </DropdownMenu>
    </span>
    {error && <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Reload approval setting" title={error} onClick={() => void refresh()}><RotateCwIcon aria-hidden className="size-3.5" /></Button>}
  </div>;
  if (compact) return <div className="min-w-0 shrink-0">{control}<span id={hint} className="sr-only">{description}</span><span role="status" className="sr-only">{busy ? "Saving approval setting…" : error}</span></div>;
  return <section aria-label="Permissions" className="space-y-3">
    <h3 className="text-sm font-semibold">Permissions</h3>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <p id={hint} className="max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>
      {control}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <p role="status" className="text-xs text-muted-foreground">{busy ? "Saving approval setting…" : preferences?.forcedAskMe ? "Managed by your organization" : "This setting applies only to your Cloud Work in this organization."}</p>
  </section>;
}
