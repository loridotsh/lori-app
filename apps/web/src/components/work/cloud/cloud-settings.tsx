"use client";

import type { CloudSettings as Settings } from "@lori-enterprise/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, SettingsRow } from "@/components/ui/section";
import {
  cloudApi,
  cloudError,
  cloudMutation,
  validateCloudSettings,
} from "@/lib/cloud-work-api";

const MIN_RETENTION = 1;
const MAX_RETENTION = 365;

function parseRetention(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value);
  return days >= MIN_RETENTION && days <= MAX_RETENTION ? days : null;
}

/**
 * Organization-level Cloud Work preferences for administrators. Whether Cloud
 * Work is available at all is decided by Manage Work Access, so only data
 * lifecycle lives here.
 */
export function CloudSettings({
  onSaved,
  onFailure,
  onDirtyChange,
  onBusyChange,
}: {
  onSaved: () => void;
  onFailure?: (failure: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [retention, setRetention] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const generation = useRef(0);
  const days = parseRetention(retention);
  const dirty = !!settings && retention !== String(settings.retentionDays);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy]);
  const refresh = (signal?: AbortSignal) => {
    const version = ++generation.current;
    setError("");
    return cloudApi<Settings>("/settings", { signal })
      .then((value) => {
        if (signal?.aborted || version !== generation.current) return;
        value = validateCloudSettings(value);
        setSettings(value);
        setRetention(String(value.retentionDays));
      })
      .catch((failure: unknown) => {
        if (!signal?.aborted && version === generation.current) {
          setError(cloudError(failure));
          onFailure?.(failure);
        }
      });
  };
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      controller.abort();
      generation.current++;
    };
    // Loads once per mount; later reloads are explicit.
  }, []);
  const invalid = retention !== "" && days === null;
  return (
    <section aria-labelledby="cloud-retention-heading" className="space-y-3">
      <h3 id="cloud-retention-heading" className="text-sm font-semibold">
        Data retention
      </h3>
      <Panel className="border-0 bg-transparent">
        <form
          className="[&>div]:px-0 [&>div]:pt-1"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!settings || busy || days === null || !dirty) return;
            const version = generation.current;
            setBusy(true);
            setSaved(false);
            setError("");
            try {
              const next = validateCloudSettings(
                await cloudApi<Settings>(
                  "/settings",
                  cloudMutation(
                    {
                      retentionDays: days,
                      expectedRevision: settings.revision,
                    },
                    "PATCH",
                  ),
                ),
              );
              if (version !== generation.current) return;
              setSettings(next);
              setRetention(String(next.retentionDays));
              setSaved(true);
              onSaved();
            } catch (failure) {
              if (version !== generation.current) return;
              setError(cloudError(failure));
              onFailure?.(failure);
            } finally {
              if (version === generation.current) setBusy(false);
            }
          }}
        >
          <SettingsRow
            label="Conversation retention"
            description="Stored conversations and responses are deleted after this many days without activity."
            hint={`${MIN_RETENTION}–${MAX_RETENTION} days`}
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label="Conversation retention in days"
                aria-invalid={invalid || undefined}
                aria-describedby="cloud-retention-feedback"
                inputMode="numeric"
                autoComplete="off"
                className="h-9 w-20 bg-card text-right tabular-nums"
                disabled={!settings || busy}
                maxLength={3}
                value={retention}
                onChange={(event) => {
                  setSaved(false);
                  setRetention(event.target.value.replace(/[^\d]/g, ""));
                }}
              />
              <span aria-hidden className="text-sm text-muted-foreground">
                days
              </span>
              <Button
                aria-label="Save settings"
                disabled={!settings || busy || !dirty || days === null}
                size="sm"
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </SettingsRow>
        </form>
      </Panel>
      <p
        id="cloud-retention-feedback"
        role="status"
        aria-live="polite"
        className="empty:hidden text-xs"
      >
        {!settings && !error ? (
          <span className="text-muted-foreground">Loading settings…</span>
        ) : invalid ? (
          <span className="text-destructive">
            Enter a whole number from {MIN_RETENTION} to {MAX_RETENTION}.
          </span>
        ) : saved ? (
          <span className="text-muted-foreground">Retention saved.</span>
        ) : null}
      </p>
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (
                dirty &&
                !window.confirm(
                  "Discard your unsaved retention change and load the latest settings?",
                )
              )
                return;
              void refresh();
            }}
          >
            Load latest settings
          </Button>
        </div>
      ) : null}
    </section>
  );
}
