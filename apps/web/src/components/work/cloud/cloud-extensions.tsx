"use client";

import type {
  CloudAuthorizationStart,
  CloudExtensionsSnapshot,
  CloudPlugin,
} from "@lori-enterprise/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogLogo } from "@/components/catalog-logo";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { cloudApi as baseCloudApi, cloudError, cloudMutation } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { cn } from "@/lib/utils";

const field =
  "h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export function CloudExtensions({
  onFailure,
  onBusyChange,
  projectId,
  readOnly = false,
  management = false,
}: {
  onFailure: (failure: unknown) => void;
  onBusyChange?: (busy: boolean) => void;
  projectId?: string;
  readOnly?: boolean;
  management?: boolean;
}) {
  const cloudApi = useCallback(<T,>(path: string, init?: RequestInit) => baseCloudApi<T>(projectId ? `/projects/${projectId}${path}${management && path === "/extensions" ? "?management=true" : ""}` : path, init), [projectId, management]);
  const [dedicated, setDedicated] = useState(false);
  const [snapshot, setSnapshot] = useState<CloudExtensionsSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const loadVersion = useRef(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [busy]);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [tab, setTab] = useState<"plugins" | "skills">("plugins");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connectMode, setConnectMode] = useState<"token" | "oauth" | null>(
    null,
  );
  const [authorization, setAuthorization] =
    useState<CloudAuthorizationStart | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      const version = ++loadVersion.current;
      // A background refresh must not flash the list or erase a visible error.
      if (!silent) {
        setLoading(true);
        setError("");
      }
      try {
        const value = await cloudApi<CloudExtensionsSnapshot>("/extensions", {
          signal,
        });
        if (signal?.aborted || version !== loadVersion.current) return;
        if (
          !value ||
          !Array.isArray(value.plugins) ||
          !Array.isArray(value.skills)
        )
          throw new ClientApiError(
            "invalid_response",
            "Extensions returned an unreadable response. Load again.",
            502,
          );
        setSnapshot(value);
        setUncertain(false);
      } catch (failure) {
        if (!signal?.aborted && version === loadVersion.current) {
          if (!silent) setError(pluginError(failure));
          onFailure(failure);
        }
      } finally {
        if (!signal?.aborted && version === loadVersion.current)
          setLoading(false);
      }
    },
    [onFailure, cloudApi],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      loadVersion.current++;
    };
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (!busy) void load(undefined, true);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load, busy]);
  const mutate = async (path: string, init: RequestInit, success: string) => {
    if (readOnly) { setError("A project connection manager must make this change."); return; }
    if (projectId && /\/(token|oauth)$/.test(path) && !dedicated) { setError("Confirm that this account is dedicated to this project."); return; }
    loadVersion.current++;
    setBusy(true);
    setError("");
    setToken("");
    setClientId("");
    setClientSecret("");
    setConnectMode(null);
    try {
      await cloudApi(path, init);
      setAnnouncement(success);
      setConfirmDisconnect(false);
      await load();
    } catch (failure) {
      // Only a lost connection or a server fault leaves the outcome unknown; a
      // definitive rejection (4xx) means nothing changed.
      if (
        !(failure instanceof ClientApiError) ||
        failure.status === 0 ||
        failure.status >= 500
      )
        setUncertain(true);
      setError(pluginError(failure));
      onFailure(failure);
    } finally {
      setBusy(false);
    }
  };
  const plugin = snapshot?.plugins.find((item) => item.id === selected);
  useEffect(() => {
    if (plugin?.connection?.status === "connected") {
      setAuthorization(null);
      setAnnouncement(`${plugin.name} connected.`);
    }
    if (plugin && !plugin.allowed) {
      setToken("");
      setClientId("");
      setClientSecret("");
      setConnectMode(null);
      setAuthorization(null);
    }
  }, [plugin?.connection?.status, plugin?.allowed]);
  useEffect(() => {
    if (!authorization || busy) return;
    let inFlight = false;
    const controller = new AbortController();
    const poll = async () => {
      if (Date.now() >= Date.parse(authorization.expiresAt)) {
        setAuthorization(null);
        setError("This sign-in expired. Start a new connection to continue.");
        return;
      }
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        await load(controller.signal, true);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [authorization, busy, load]);
  const startAuthorization = async (
    credentials: { clientId?: string; clientSecret?: string } = {},
  ) => {
    if (!plugin || busy || readOnly) return;
    if (projectId && !dedicated) { setError("Confirm that this account is dedicated to this project."); return; }
    loadVersion.current++;
    setBusy(true);
    setError("");
    setToken("");
    setClientId("");
    setClientSecret("");
    setConnectMode(null);
    try {
      const next = await cloudApi<CloudAuthorizationStart>(
        `/extensions/plugins/${encodeURIComponent(plugin.id)}/oauth`,
        cloudMutation({ ...credentials, ...(projectId ? { projectDedicatedAccount: true } : {}) }),
      );
      if (
        !safeHttps(next.authorizationUrl) ||
        !Number.isFinite(Date.parse(next.expiresAt))
      )
        throw new ClientApiError(
          "invalid_authorization_url",
          "The provider returned invalid sign-in details. Reload status and try again.",
          502,
        );
      setAuthorization(next);
      await load();
    } catch (failure) {
      setUncertain(
        !(failure instanceof ClientApiError) ||
          failure.status === 0 ||
          failure.status >= 500,
      );
      setError(pluginError(failure));
      onFailure(failure);
    } finally {
      setBusy(false);
    }
  };
  const open = (id: string | null) => {
    setDedicated(false);
    setSelected(id);
    setToken("");
    setClientId("");
    setClientSecret("");
    setConnectMode(null);
    setAuthorization(null);
    setConfirmDisconnect(false);
    setError("");
  };
  const cancelSignIn =
    plugin?.connection?.status === "connecting" ? (
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || loading || uncertain}
        onClick={() => {
          setAuthorization(null);
          void mutate(
            `/extensions/plugins/${encodeURIComponent(plugin.id)}`,
            cloudMutation(
              { expectedRevision: plugin.connection!.revision },
              "DELETE",
            ),
            "Sign-in cancelled.",
          );
        }}
      >
        Cancel sign-in
      </Button>
    ) : null;
  return (
    <div className="mt-6">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {error && (
        <div role="alert" className="mb-5 space-y-2 text-sm">
          <p className="text-destructive">{error}</p>
          {uncertain && (
            <p className="text-xs leading-5 text-muted-foreground">
              The change may have been received. Reload connection status before
              making another change. Your credentials have been cleared.
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Reload status
          </Button>
        </div>
      )}
      {plugin ? (
        <section>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => open(null)}
            className="-ml-3 mb-5"
          >
            <ArrowLeftIcon />
            All plugins
          </Button>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-5">
            <div className="flex min-w-0 items-start gap-4">
              <CatalogLogo id={plugin.id} type="plugin" size="lg" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="break-words text-lg font-semibold">
                    {plugin.name}
                  </h3>
                  <p
                    className={cn(
                      "inline-flex items-center text-xs",
                      plugin.connection?.status === "connected" &&
                        plugin.connection.enabled &&
                        plugin.allowed
                        ? "text-success-muted-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {pluginStatus(plugin)}
                  </p>
                </div>
                {plugin.description && (
                  <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                    {plugin.description}
                  </p>
                )}
              </div>
            </div>
            {plugin.connection &&
              plugin.connection.status !== "disconnected" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || loading}
                  onClick={() =>
                    plugin.connection?.status === "connected" &&
                    plugin.connection.enabled
                      ? void mutate(
                          `/extensions/plugins/${encodeURIComponent(plugin.id)}/refresh`,
                          cloudMutation({
                            expectedRevision: plugin.connection.revision,
                          }),
                          `${plugin.name} connection verified.`,
                        )
                      : void load()
                  }
                >
                  <RefreshCwIcon />
                  Refresh status
                </Button>
              )}
          </div>
          {!plugin.allowed && (
            <p className="mt-4 text-sm text-muted-foreground">
              Your organization has not allowed this plugin in Cloud Work.
            </p>
          )}
          <div className="mt-6 max-w-xl space-y-4">
            {projectId && !readOnly && <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><input type="checkbox" className="mt-1" checked={dedicated} onChange={event => setDedicated(event.target.checked)} />This account is dedicated to this project’s data. Results from it are shared with project members.</label>}
            {readOnly && <p className="text-sm text-muted-foreground">Project connections are managed by your administrator or project manager.</p>}
            {plugin.connection &&
              ["connected", "reauthRequired"].includes(
                plugin.connection.status,
              ) && (
                <div className="space-y-3">
                  {plugin.connection.status === "connected" && (
                    <p className="text-xs text-muted-foreground">
                      {plugin.connection.toolCount} tools ·{" "}
                      {plugin.connection.resourceCount} resources
                    </p>
                  )}
                  {plugin.connection.status === "connected" && (
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm">
                        Use {plugin.name} in Cloud Work
                      </span>
                      <Toggle
                        aria-label={`Use ${plugin.name} in Cloud Work`}
                        checked={plugin.connection.enabled}
                        disabled={
                          busy ||
                          loading ||
                          uncertain ||
                          !plugin.allowed ||
                          plugin.connection.status !== "connected"
                        }
                        onChange={(next) =>
                          void mutate(
                            `/extensions/plugins/${encodeURIComponent(plugin.id)}`,
                            cloudMutation(
                              {
                                expectedRevision: plugin.connection!.revision,
                                enabled: next,
                              },
                              "PATCH",
                            ),
                            `${plugin.name} ${next ? "enabled" : "disabled"}.`,
                          )
                        }
                      />
                    </div>
                  )}
                  {confirmDisconnect ? (
                    <div>
                      <p className="text-sm">
                        Disconnect {plugin.name} and remove its saved
                        credentials?
                      </p>
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy || uncertain}
                          onClick={() =>
                            void mutate(
                              `/extensions/plugins/${encodeURIComponent(plugin.id)}`,
                              cloudMutation(
                                {
                                  expectedRevision: plugin.connection!.revision,
                                },
                                "DELETE",
                              ),
                              `${plugin.name} disconnected.`,
                            )
                          }
                        >
                          Disconnect plugin
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDisconnect(false)}
                        >
                          Keep connection
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || loading || uncertain}
                      onClick={() => setConfirmDisconnect(true)}
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              )}
            {plugin.allowed &&
              (!plugin.connection ||
                ["disconnected", "reauthRequired", "connecting"].includes(
                  plugin.connection.status,
                )) &&
              !authorization && (
                <div className="space-y-3">
                  {plugin.connection?.status === "connecting" &&
                    !connectMode && (
                      <p className="text-sm leading-6 text-muted-foreground">
                        Finish sign-in in the provider window, or start again
                        here.
                      </p>
                    )}
                  {!connectMode && (
                    <div className="flex flex-wrap items-start gap-2">
                      {["token", "oauthOrKey"].includes(plugin.auth) && (
                        <Button
                          size="sm"
                          disabled={busy || loading || uncertain}
                          onClick={() => setConnectMode("token")}
                        >
                          Connect with API token
                        </Button>
                      )}
                      {["oauth", "registeredOAuth", "oauthOrKey"].includes(
                        plugin.auth,
                      ) && (
                        <div className="space-y-2">
                          <Button
                            size="sm"
                            variant={
                              plugin.auth === "oauthOrKey"
                                ? "outline"
                                : "default"
                            }
                            disabled={
                              busy ||
                              loading ||
                              uncertain ||
                              !snapshot?.callbackUrl
                            }
                            aria-describedby={
                              !snapshot?.callbackUrl
                                ? "plugin-oauth-unavailable"
                                : undefined
                            }
                            onClick={() =>
                              plugin.auth === "registeredOAuth"
                                ? setConnectMode("oauth")
                                : void startAuthorization()
                            }
                          >
                            {busy
                              ? "Preparing sign-in…"
                              : plugin.connection?.status === "connecting"
                                ? "Restart sign-in"
                                : plugin.connection?.status === "reauthRequired"
                                  ? "Reconnect account"
                                  : "Connect account"}
                          </Button>
                          {!snapshot?.callbackUrl && (
                            <p
                              id="plugin-oauth-unavailable"
                              className="max-w-lg text-xs leading-5 text-muted-foreground"
                            >
                              Account sign-in needs a secure callback. Ask your
                              administrator to set LORI_ADDRESS to this
                              deployment's HTTPS address. Local development also
                              supports localhost callbacks.
                            </p>
                          )}
                        </div>
                      )}
                      {cancelSignIn}
                    </div>
                  )}
                  {connectMode && (
                    <form
                      className="space-y-4"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        const credentials = {
                          token: token.trim(),
                          clientId: clientId.trim(),
                          clientSecret,
                        };
                        for (const input of Array.from(
                          event.currentTarget.elements,
                        ))
                          if (input instanceof HTMLInputElement)
                            input.value = "";
                        setToken("");
                        setClientId("");
                        setClientSecret("");
                        if (connectMode === "token") {
                          await mutate(
                            `/extensions/plugins/${encodeURIComponent(plugin.id)}/token`,
                            cloudMutation({ token: credentials.token, ...(projectId ? { projectDedicatedAccount: true } : {}) }),
                            `${plugin.name} connected.`,
                          );
                          return;
                        }
                        await startAuthorization({
                          clientId: credentials.clientId,
                          clientSecret: credentials.clientSecret,
                        });
                      }}
                    >
                      {connectMode === "token" ? (
                        <label className="grid gap-2 text-sm">
                          API token
                          <input
                            aria-label={`${plugin.name} API token`}
                            type="password"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            autoComplete="off"
                            required
                            maxLength={8192}
                            disabled={busy || uncertain}
                            className={field}
                          />
                        </label>
                      ) : plugin.auth === "registeredOAuth" ? (
                        <>
                          <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
                            <p className="text-xs font-medium">
                              Register this callback URL in your {plugin.name}{" "}
                              app
                            </p>
                            <code className="block select-all break-all text-xs leading-5 text-muted-foreground">
                              {snapshot?.callbackUrl}
                            </code>
                          </div>
                          <label className="grid gap-2 text-sm">
                            OAuth client ID
                            <input
                              value={clientId}
                              maxLength={4096}
                              onChange={(event) =>
                                setClientId(event.target.value)
                              }
                              autoComplete="off"
                              required
                              disabled={busy || uncertain}
                              className={field}
                            />
                          </label>
                          <label className="grid gap-2 text-sm">
                            OAuth client secret
                            <input
                              type="password"
                              value={clientSecret}
                              maxLength={8192}
                              onChange={(event) =>
                                setClientSecret(event.target.value)
                              }
                              autoComplete="off"
                              required
                              disabled={busy || uncertain}
                              className={field}
                            />
                          </label>
                        </>
                      ) : (
                        <p className="text-sm leading-6 text-muted-foreground">
                          Continue to {plugin.name} to choose the account and
                          permissions Lori can use.
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy || uncertain}>
                          {busy
                            ? "Connecting…"
                            : connectMode === "token"
                              ? "Save connection"
                              : "Start authorization"}
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setConnectMode(null);
                            setToken("");
                            setClientId("");
                            setClientSecret("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            {authorization && (
              <div className="space-y-3">
                <p className="text-sm leading-6 text-muted-foreground">
                  Approve access in {plugin.name}. This page updates
                  automatically.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm">
                    <a
                      href={authorization.authorizationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      Continue to {plugin.name}
                      <ExternalLinkIcon />
                    </a>
                  </Button>
                  {cancelSignIn}
                </div>
              </div>
            )}
            {(plugin.setup || safeHttps(plugin.docsUrl)) && (
              <details className="pt-2 text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  Setup help
                </summary>
                <div className="mt-3 space-y-3">
                  {plugin.setup && (
                    <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {plugin.setup}
                    </p>
                  )}
                  {safeHttps(plugin.docsUrl) && (
                    <a
                      href={plugin.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Setup instructions
                      <ExternalLinkIcon aria-hidden className="size-3" />
                    </a>
                  )}
                </div>
              </details>
            )}
          </div>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
            <nav
              aria-label="Extension categories"
              className="flex gap-1 rounded-lg bg-secondary/70 p-1"
            >
              {(["plugins", "skills"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-label={kind === "plugins" ? "Plugins" : "Skills"}
                  aria-pressed={tab === kind}
                  onClick={() => {
                    setTab(kind);
                    setSearch("");
                  }}
                  className={cn(
                    "inline-flex min-h-8 items-center gap-2 rounded-md px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    tab === kind
                      ? "bg-card font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {kind === "plugins" ? "Plugins" : "Skills"}
                  {snapshot && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {snapshot[kind].length}
                    </span>
                  )}
                </button>
              ))}
            </nav>
            <div className="flex min-w-0 basis-full items-center gap-1 @lg:max-w-64 @lg:flex-1 @lg:basis-auto">
              <div className="relative min-w-0 flex-1">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  aria-label="Search extensions"
                  placeholder={
                    tab === "plugins" ? "Search plugins" : "Search skills"
                  }
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className={cn(field, "h-9 bg-card pl-9")}
                />
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Refresh extensions"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                <RefreshCwIcon />
              </Button>
            </div>
          </div>
          {loading && !snapshot ? (
            <div
              role="status"
              aria-label="Loading extensions"
              className="divide-y divide-border/60"
            >
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  aria-hidden
                  className="flex items-center gap-3 py-5"
                >
                  <div className="size-10 animate-pulse rounded-lg bg-secondary motion-reduce:animate-none" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
                  </div>
                </div>
              ))}
            </div>
          ) : snapshot && tab === "plugins" ? (
            <ul className="divide-y divide-border/60">
              {snapshot.plugins
                .filter((item) => matches(item, search))
                .map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="group grid min-h-20 w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-4 text-left outline-none transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none @lg:flex"
                      onClick={() => open(item.id)}
                    >
                      <CatalogLogo id={item.id} type="plugin" />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium">
                          {item.name}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "col-start-2 row-start-2 text-xs @lg:ml-3 @lg:shrink-0 @lg:text-right",
                          item.allowed &&
                            item.connection?.status === "connected" &&
                            item.connection.enabled
                            ? "text-success-muted-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {pluginStatus(item)}
                      </span>
                      <ChevronRightIcon
                        aria-hidden
                        className="col-start-3 row-start-1 size-4 shrink-0 text-muted-foreground/70 group-hover:text-foreground"
                      />
                    </button>
                  </li>
                ))}
            </ul>
          ) : snapshot ? (
            <ul className="divide-y divide-border/60">
              {snapshot.skills
                .filter((item) => matches(item, search))
                .map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start justify-between gap-4 px-2 py-5"
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <CatalogLogo id={item.id} type="skill" />
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-medium">
                          {item.name}
                        </h3>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {item.description}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Version {item.version}
                          {!item.allowed &&
                            " · Not allowed by your organization"}
                        </p>
                      </div>
                    </div>
                    <Toggle
                      aria-label={`Enable ${item.name}`}
                      checked={item.enabled}
                      disabled={readOnly || !item.allowed || busy || loading || uncertain}
                      onChange={(next) =>
                        void mutate(
                          `/extensions/skills/${encodeURIComponent(item.id)}`,
                          cloudMutation({ enabled: next }, "PATCH"),
                          `${item.name} ${next ? "enabled" : "disabled"}.`,
                        )
                      }
                    />
                  </li>
                ))}
            </ul>
          ) : null}
          {snapshot &&
            !(tab === "plugins" ? snapshot.plugins : snapshot.skills).some(
              (item) => matches(item, search),
            ) && (
              <p
                role="status"
                className="py-12 text-center text-sm text-muted-foreground"
              >
                {search ? "No matching extensions." : `No ${tab} available.`}
              </p>
            )}
        </>
      )}
    </div>
  );
}
const matches = (
  item: { name: string; description?: string },
  search: string,
) =>
  `${item.name} ${item.description ?? ""}`
    .toLocaleLowerCase()
    .includes(search.toLocaleLowerCase());
function pluginStatus(plugin: CloudPlugin) {
  if (!plugin.allowed) return "Not allowed";
  if (!plugin.connection || plugin.connection.status === "disconnected")
    return "Not connected";
  if (plugin.connection.status === "reauthRequired")
    return "Reconnect required";
  if (plugin.connection.status === "connecting") return "Authorization pending";
  return plugin.connection.enabled ? "Connected" : "Disabled";
}
function safeHttps(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function pluginError(failure: unknown) {
  const messages: Record<string, string> = {
    cloud_extension_https_callback_required:
      "Account sign-in needs a secure callback. Ask your administrator to configure this deployment's HTTPS address.",
    cloud_extension_app_configuration_required:
      "This provider needs a registered app with a client ID and client secret. Review its setup instructions and try again.",
    cloud_extension_reauth_required:
      "This account needs to be connected again. Refresh status, then reconnect your account.",
    cloud_extension_connection_failed:
      "The provider could not verify this token. Check its permissions and try again. If the provider is unavailable, wait before retrying.",
    cloud_extension_authorization_failed:
      "The provider could not start or refresh sign-in. Try again shortly, or review your registered app settings.",
    cloud_extension_revision_changed:
      "This connection changed in another window. Refresh status before making another change.",
    cloud_extension_policy_denied:
      "Your organization does not allow this plugin. Ask an administrator to review your Work access.",
  };
  return failure instanceof ClientApiError && messages[failure.code]
    ? messages[failure.code]!
    : cloudError(failure);
}
