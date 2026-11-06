"use client";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { useWorkNotifications } from "./provider";

export function NotificationSettings() {
  const state = useWorkNotifications();
  const status = state.busy ? "Saving…" : !state.enabled ? "Off"
    : state.permission === "granted" && !state.error ? "On" : "Paused";

  return (
    <section aria-labelledby="work-notifications-heading" className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 id="work-notifications-heading" className="text-sm font-semibold">Notifications</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">When work finishes or needs your attention.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span role="status" className="text-xs text-muted-foreground">{status}</span>
          <Toggle aria-label="Work notifications" checked={state.enabled}
            disabled={state.busy || (!state.supported && !state.enabled)}
            onChange={() => void state.toggle()} />
        </div>
      </div>
      <div className="flex items-start justify-between gap-3">
        <details className="min-w-0 flex-1 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm py-2 underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Delivery &amp; privacy</summary>
          <div className="max-w-prose space-y-2 pb-1 pt-1 leading-5">
            <p>Applies to this account in this browser while Enterprise is open. Alerts cover completed work, failures, interruptions, and approval requests. Conversation contents stay private.</p>
            <p>If a test arrives without a banner, check your browser’s system notification settings and Focus or Do Not Disturb.</p>
          </div>
        </details>
        {state.enabled && (
          <Button type="button" variant="ghost" size="sm" className="shrink-0"
            aria-label="Send test notification"
            disabled={state.busy || state.testing || state.permission !== "granted"}
            onClick={() => void state.testNotification()}>
            {state.testing ? "Sending…" : "Send test"}
          </Button>
        )}
      </div>
      {!state.supported && <p className="text-xs leading-5 text-muted-foreground">Use HTTPS and a browser that supports system notifications.</p>}
      {state.enabled && state.permission !== "granted" && !state.error && (
        <p className="text-xs leading-5 text-muted-foreground">Allow notifications in your browser’s site settings to resume alerts.</p>
      )}
      {state.testResult && <p role="status" className="text-xs leading-5 text-muted-foreground">{state.testResult}</p>}
      {state.error && <p role="alert" className="break-words text-xs leading-5 text-destructive">{state.error}</p>}
    </section>
  );
}
