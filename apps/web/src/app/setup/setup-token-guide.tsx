"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, KeyRoundIcon } from "lucide-react";
import type { SetupTokenGuidance } from "@lori-enterprise/contracts";
import { Button } from "@/components/ui/button";

const DOCKER_PRINT_TOKEN = "docker compose --profile tools run --rm --no-deps -T setup-token";
const DOCKER_ROTATE_TOKEN = "docker compose --profile tools run --rm --no-deps -T setup-token-rotate";

function CommandBlock({ command, label }: { command: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(command);
      setStatus("copied");
      timer.current = setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("failed");
    }
  }
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-background p-2 pl-3">
        <code className="min-w-0 flex-1 select-all whitespace-pre-wrap break-all py-1.5 font-mono text-xs leading-5">{command}</code>
        <Button aria-label={`Copy command: ${label}`} onClick={() => void copy()} size="icon" type="button" variant="ghost">
          {status === "copied" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </Button>
      </div>
      <p aria-live="polite" className={status === "failed" ? "text-xs text-destructive" : "sr-only"}>
        {status === "failed" ? "Could not copy. Select the command and copy it manually." : status === "copied" ? "Copied to clipboard." : ""}
      </p>
    </div>
  );
}

export function SetupTokenGuide({ guidance }: { guidance: SetupTokenGuidance }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!guidance.expiresAt) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [guidance.expiresAt]);
  const expiresAt = guidance.expiresAt ? Date.parse(guidance.expiresAt) : NaN;
  const remaining = now !== null && Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now) / 60_000)) : null;
  const development = guidance.source === "local_development";
  return (
    <div className="min-w-0 space-y-2">
      <details className="group min-w-0 rounded-lg border border-border bg-secondary/30">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3 outline-none transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-sm font-medium">{development ? "Local development token" : "Get your setup token"}</span>
          <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="min-w-0 space-y-4 border-t border-border px-4 py-4">
          {development ? (
            guidance.developmentToken ? <CommandBlock command={guidance.developmentToken} label="Copy the development token" /> :
            <p className="text-sm text-muted-foreground">No development token is available. Check your local API configuration.</p>
          ) : (
            <>
              <p className="text-sm leading-6 text-muted-foreground">On the machine running Lori Enterprise, open your deployment terminal and run:</p>
              <CommandBlock command={DOCKER_PRINT_TOKEN} label="Copy the one-time token" />
              <p className="text-xs leading-5 text-muted-foreground">Use the same Compose files and project name as your install command. For an OCI install, include your <code>-f oci://…</code> and <code>-p</code> options. Keep the token private.</p>
              <details className="min-w-0 border-t border-border pt-3">
                <summary className="cursor-pointer rounded-sm py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Token expired or setup interrupted?</summary>
                <div className="min-w-0 space-y-3 pt-3">
                  <CommandBlock command={DOCKER_ROTATE_TOKEN} label="Generate a new token" />
                  <CommandBlock command="docker compose restart api" label="Reload the API" />
                  <p className="text-xs leading-5 text-muted-foreground">Refresh this page, then paste the new token.</p>
                </div>
              </details>
            </>
          )}
        </div>
      </details>
      {!development && remaining !== null && (
        <p className={remaining === 0 ? "px-1 text-xs leading-5 text-destructive" : "px-1 text-xs leading-5 text-muted-foreground"}>
          {remaining === 0 ? "Your setup token has expired. Open the guide above to renew it." : `Token expires in ${remaining} minute${remaining === 1 ? "" : "s"}.`}
        </p>
      )}
    </div>
  );
}
