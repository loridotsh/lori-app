"use client";

import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ClientApiError } from "@/lib/client-api";
import { workApi as clientApi } from "@/lib/work-api";
import {
  connectionFailure,
  validConnection,
  type WorkProviderConnection,
} from "./work-provider-utils";

export function WorkProviderConnectionDialog({
  providerId,
  providerName,
  connection,
  personalWorkspace = false,
  revision,
  onClose,
  onSaved,
  onReviewLatest,
}: {
  providerId: string;
  providerName: string;
  connection?: WorkProviderConnection;
  personalWorkspace?: boolean;
  revision: number;
  onClose(): void;
  onSaved(connection: WorkProviderConnection): void;
  onReviewLatest(): void;
}) {
  const [key, setKey] = useState("");
  const [rateInput, setRateInput] = useState(
    String(connection?.requestsPerMinute ?? 60),
  );
  const [fieldError, setFieldError] = useState<string | null>(null);
  const rate = Number(rateInput);
  const rateValid =
    /^\d+$/.test(rateInput) &&
    Number.isInteger(rate) &&
    rate >= 1 &&
    rate <= 600;
  const rateChanged = rate !== connection?.requestsPerMinute;
  const changed = Boolean(key.trim()) || rateChanged;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ReturnType<
    typeof connectionFailure
  > | null>(null);
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const keyInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    keyInput.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (retryUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryUntil) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryUntil]);
  const waiting = retryUntil > now;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      inFlight.current ||
      waiting ||
      failure?.reload ||
      failure?.signIn ||
      !changed
    )
      return;
    if (!rateValid) {
      setFieldError("Enter a whole-number request limit between 1 and 600.");
      return;
    }
    if (
      (!connection && !key.trim()) ||
      key.trim().length > 8192 ||
      /[\u0000-\u001f\u007f]/.test(key.trim())
    ) {
      setFieldError("Enter a single-line API key of 1–8,192 characters.");
      return;
    }
    const apiKey = key.trim();
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    setFieldError(null);
    setKey("");
    try {
      const saved = await clientApi<WorkProviderConnection>(
        connection
          ? `/v1/admin/work/provider-gateways/${encodeURIComponent(connection.id)}`
          : "/v1/admin/work/provider-gateways",
        {
          method: connection ? "PATCH" : "POST",
          body: JSON.stringify({
            ...(apiKey ? { apiKey } : {}),
            expectedRevision: revision,
            ...(!connection ? { providerId } : {}),
            ...(!connection || rateChanged ? { requestsPerMinute: rate } : {}),
          }),
        },
      );
      if (
        !validConnection(saved) ||
        saved.providerId !== providerId ||
        saved.policyRevision <= revision
      )
        throw new ClientApiError(
          "malformed_response",
          "Invalid connection response",
          0,
        );
      if (mounted.current)
        onSaved({
          id: saved.id,
          providerId: saved.providerId,
          providerName,
          credentialConfigured: true,
          requestsPerMinute: saved.requestsPerMinute,
          policyRevision: saved.policyRevision,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
        });
    } catch (reason) {
      if (!mounted.current) return;
      const next = connectionFailure(reason);
      if (
        !(reason instanceof ClientApiError) ||
        reason.status === 0 ||
        reason.status >= 500
      ) {
        next.reload = true;
        next.message =
          "The save outcome is unknown. Reload connection status before trying again. Your unsaved Work assignments remain on this page.";
      }
      setFailure(next);
      if (
        reason instanceof ClientApiError &&
        (reason.status === 400 || reason.status === 422)
      )
        setFieldError(
          "Check the provider key and request limit, then try again. Re-enter the key if you want to replace it.",
        );
      if (next.retryAfterSeconds) {
        setNow(Date.now());
        setRetryUntil(Date.now() + next.retryAfterSeconds * 1000);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <Dialog
      open
      title={
        connection
          ? `Update ${providerName} ${personalWorkspace ? "API" : "company"} key`
          : `Connect ${providerName} for Work`
      }
      onClose={() => {
        if (!pending) {
          setKey("");
          onClose();
        }
      }}
      description={
        personalWorkspace
          ? "Your key is encrypted and stored. It is used for both Work and Code."
          : "This company connection is shared with Code. Changing its key or request limit affects both products; Code model access is preserved."
      }
    >
      <form
        className="space-y-5"
        onSubmit={(event) => void save(event)}
        aria-busy={pending}
      >
        <div className="space-y-2">
          <label
            className="text-sm font-medium"
            htmlFor="work-company-provider-key"
          >
            {connection ? "New API key" : "Provider API key"}
          </label>
          <Input
            ref={keyInput}
            id="work-company-provider-key"
            type="password"
            maxLength={8192}
            aria-invalid={fieldError ? true : undefined}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            value={key}
            disabled={pending || failure?.reload || failure?.signIn}
            onChange={(event) => {
              setKey(event.target.value);
              setFieldError(null);
            }}
            aria-describedby="work-company-provider-key-help"
          />
          <p
            id="work-company-provider-key-help"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            Stored encrypted on your Enterprise server. The key is never shown
            again. Saving stores the connection; it does not verify the provider
            or grant members access.
          </p>
        </div>
        {connection ? (
          <p className="text-xs text-muted-foreground">
            Leave the key blank to keep it. Enter a new key only to replace it.
          </p>
        ) : null}
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Request limit
          </summary>
          <div className="mt-3 space-y-2">
            <label
              htmlFor="work-company-request-limit"
              className="text-sm font-medium"
            >
              Requests per minute
            </label>
            <Input
              id="work-company-request-limit"
              aria-invalid={!rateValid ? true : undefined}
              type="number"
              min={1}
              max={600}
              step={1}
              value={rateInput}
              disabled={pending || failure?.reload || failure?.signIn}
              onChange={(event) => {
                setRateInput(event.target.value);
                setFieldError(null);
              }}
            />
            <p className="text-xs text-muted-foreground">
              A shared whole-number limit of 1–600 requests for Code and Work.
            </p>
          </div>
        </details>
        {fieldError ? (
          <p className="text-xs text-destructive" role="alert">
            {fieldError}
          </p>
        ) : null}
        {failure ? (
          <Alert variant="destructive">
            <p>{failure.message}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {failure.reload ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onReviewLatest();
                    onClose();
                  }}
                >
                  Reload latest
                </Button>
              ) : null}
              {failure.signIn ? (
                <Button asChild variant="outline" size="sm">
                  <a href="/sign-in" target="_blank" rel="noreferrer">
                    Sign in again
                  </a>
                </Button>
              ) : null}
              {waiting ? (
                <span className="text-xs">
                  Try again in {Math.ceil((retryUntil - now) / 1000)} seconds.
                </span>
              ) : null}
            </div>
          </Alert>
        ) : null}
        {pending ? (
          <p
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2Icon
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            Saving company connection…
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setKey("");
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              pending ||
              waiting ||
              !changed ||
              !rateValid ||
              (!connection && !key.trim()) ||
              failure?.reload ||
              failure?.signIn
            }
          >
            <KeyRoundIcon aria-hidden />
            {pending
              ? "Saving…"
              : connection
                ? key.trim()
                  ? `Replace ${personalWorkspace ? "API" : "company"} key`
                  : "Save connection limit"
                : personalWorkspace
                  ? "Save API key"
                  : "Save company connection"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
