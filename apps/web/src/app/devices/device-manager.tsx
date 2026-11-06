"use client";

import type { Device, DevicesResponse } from "@lori-enterprise/contracts";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LaptopIcon,
  MonitorIcon,
  RefreshCwIcon,
  ShieldOffIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, Section } from "@/components/ui/section";
import { ClientApiError, clientApi } from "@/lib/client-api";
import {
  desktopConnectUrl,
  desktopLaunchGuidance,
  usesDevelopmentDesktopHandoff,
} from "@/lib/desktop-connect";

function statusBadge(status: Device["status"]) {
  if (status === "connected") {
    return (
      <Badge className="gap-1.5" variant="success">
        <span className="size-1.5 rounded-full bg-success status-dot-pulse" />
        Connected
      </Badge>
    );
  }
  if (status === "revoked") {
    return (
      <Badge className="gap-1.5" variant="destructive">
        <span className="size-1.5 rounded-full bg-destructive" />
        Revoked
      </Badge>
    );
  }
  return (
    <Badge className="gap-1.5" variant="warning">
      <span className="size-1.5 rounded-full bg-warning" />
      Expired
    </Badge>
  );
}

function LocalDateTime({
  prefix = "",
  value,
}: {
  prefix?: string;
  value: string;
}) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(new Date(value).toLocaleString());
  }, [value]);

  return (
    <time dateTime={value}>
      {prefix}
      {label ?? "…"}
    </time>
  );
}

function platformIcon(platform: Device["platform"]) {
  if (platform === "macos") return LaptopIcon;
  if (platform === "windows" || platform === "linux") return MonitorIcon;
  return SmartphoneIcon;
}

const agentNames: Record<string, string> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  hermes: "Hermes",
  opencode: "OpenCode",
  pi: "Pi",
};

function formatAgents(agents: string[]): string {
  return agents.map((agent) => agentNames[agent] ?? agent).join(", ");
}

type DeviceRequestAction = "refresh" | "revoke";
type DeviceErrorRecovery = "refresh" | "sign-in" | null;

interface DeviceRequestFeedback {
  message: string;
  recovery: DeviceErrorRecovery;
}

function deviceRequestFeedback(
  error: unknown,
  action: DeviceRequestAction,
): DeviceRequestFeedback {
  if (error instanceof ClientApiError) {
    if (error.status === 401) {
      return {
        message: "Your dashboard session expired. Sign in again, then retry.",
        recovery: "sign-in",
      };
    }
    if (error.status === 403) {
      return {
        message:
          action === "revoke"
            ? "You do not have permission to revoke this device."
            : "You do not have permission to view the latest device status.",
        recovery: null,
      };
    }
    if (error.status === 404 && action === "revoke") {
      return {
        message:
          "This device no longer exists. Refresh the list to see the latest status.",
        recovery: "refresh",
      };
    }
    if (error.status === 429) {
      return {
        message:
          "Too many device requests were made. Wait a moment, then try again.",
        recovery: "refresh",
      };
    }
    if (error.status >= 500) {
      return {
        message:
          action === "revoke"
            ? "The server could not revoke this device. It remains connected. Refresh status and try again."
            : "Live device status is temporarily unavailable. The last loaded information is still shown.",
        recovery: "refresh",
      };
    }
  }
  return {
    message:
      action === "revoke"
        ? "The device could not be revoked. It remains connected. Check your connection and try again."
        : "Could not reach Lori Enterprise. The last loaded device status is still shown.",
    recovery: "refresh",
  };
}

export function DeviceManager({
  initialDevices,
  organizationWide,
  publicUrl,
}: {
  initialDevices: Device[];
  organizationWide: boolean;
  publicUrl: string;
}) {
  const [devices, setDevices] = useState(initialDevices);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<DeviceRequestFeedback | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [statusStale, setStatusStale] = useState(false);
  const [launchAttempted, setLaunchAttempted] = useState(false);
  const refreshSequence = useRef(0);
  const refreshInFlight = useRef(false);
  const activeCount = devices.filter(
    (device) => device.status === "connected",
  ).length;
  const development = usesDevelopmentDesktopHandoff(publicUrl);
  const desktopUrl = desktopConnectUrl(publicUrl, development);
  const packagedDesktopUrl = development
    ? desktopConnectUrl(publicUrl, false)
    : null;

  const refreshDevices = useCallback(
    async (quiet = false) => {
      if (quiet && refreshInFlight.current) return;
      const requestSequence = ++refreshSequence.current;
      refreshInFlight.current = true;
      if (!quiet) {
        setError(null);
        setRefreshing(true);
      }
      try {
        const response = await clientApi<DevicesResponse>(
          organizationWide ? "/v1/admin/devices" : "/v1/devices",
        );
        if (requestSequence === refreshSequence.current) {
          setDevices(response.devices);
          setStatusStale(false);
          setError(null);
        }
      } catch (requestError) {
        if (requestSequence === refreshSequence.current) {
          setStatusStale(true);
          if (!quiet) {
            setError(deviceRequestFeedback(requestError, "refresh"));
          }
        }
      } finally {
        if (requestSequence === refreshSequence.current) {
          refreshInFlight.current = false;
          if (!quiet) setRefreshing(false);
        }
      }
    },
    [organizationWide],
  );

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshDevices(true);
      }
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshDevices]);

  async function revoke(deviceId: string) {
    setError(null);
    setPending(deviceId);
    try {
      await clientApi(
        `${organizationWide ? "/v1/admin" : "/v1"}/devices/${deviceId}`,
        { method: "DELETE" },
      );
      setDevices((current) =>
        current.map((device) =>
          device.id === deviceId
            ? {
                ...device,
                revokedAt: new Date().toISOString(),
                status: "revoked",
              }
            : device,
        ),
      );
      setConfirming(null);
      setStatusStale(false);
    } catch (requestError) {
      setConfirming(null);
      setError(deviceRequestFeedback(requestError, "revoke"));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-8">
      {error && (
        <Alert variant="destructive">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{error.message}</span>
            {error.recovery === "sign-in" ? (
              <Button asChild className="shrink-0" size="sm" variant="outline">
                <a href="/sign-in">Sign in</a>
              </Button>
            ) : error.recovery === "refresh" ? (
              <Button
                className="shrink-0"
                disabled={refreshing}
                onClick={() => void refreshDevices(false)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
                {refreshing ? "Refreshing…" : "Try refresh"}
              </Button>
            ) : null}
          </div>
        </Alert>
      )}
      {statusStale && !error && (
        <Alert variant="warning">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Live status is temporarily unavailable. Showing the last loaded
              device information.
            </span>
            <Button
              className="shrink-0"
              disabled={refreshing}
              onClick={() => void refreshDevices(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing…" : "Try again"}
            </Button>
          </div>
        </Alert>
      )}

      <Section
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{activeCount} active</Badge>
            <Button
              disabled={refreshing}
              onClick={() => void refreshDevices(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh status"}
            </Button>
            {desktopUrl ? (
              <Button asChild size="sm">
                <a
                  href={desktopUrl}
                  referrerPolicy={development ? "no-referrer" : undefined}
                  rel={development ? "noopener" : undefined}
                  target={development ? "_blank" : undefined}
                  onClick={() => setLaunchAttempted(true)}
                >
                  <ExternalLinkIcon />
                  Open Lori
                </a>
              </Button>
            ) : null}
          </div>
        }
        description={
          organizationWide
            ? "Desktop devices linked to this organization."
            : "Desktop devices linked to your account."
        }
        title="Connected installations"
      >
        {desktopUrl && launchAttempted ? (
          <Alert className="mb-4">
            {desktopLaunchGuidance(development)}
            {packagedDesktopUrl ? (
              <>
                {" "}Testing the packaged app instead?{" "}
                <a
                  className="font-medium underline underline-offset-4"
                  href={packagedDesktopUrl}
                >
                  Open installed Lori
                </a>
                .
              </>
            ) : null}
          </Alert>
        ) : null}

        {!desktopUrl ? (
          <Alert className="mb-4" variant="destructive">
            Device enrollment is unavailable because the deployment does not
            expose a valid organization address. Ask the operator to verify
            LORI_ADDRESS.
          </Alert>
        ) : null}

        <Panel>
          {devices.length === 0 ? (
            <EmptyState
              action={desktopUrl ? (
                <Button asChild size="sm" variant="outline">
                  <a
                    className="inline-flex items-center gap-2"
                    href={desktopUrl}
                    referrerPolicy={development ? "no-referrer" : undefined}
                    rel={development ? "noopener" : undefined}
                    target={development ? "_blank" : undefined}
                    onClick={() => setLaunchAttempted(true)}
                  >
                    <ExternalLinkIcon className="size-4" />
                    Open Lori Desktop
                  </a>
                </Button>
              ) : undefined}
              description="A device appears here after Lori desktop completes browser PKCE enrollment."
              icon={LaptopIcon}
              title="No devices connected"
            />
          ) : (
            <ul className="divide-y divide-border">
              {devices.map((device) => {
                const PlatformIcon = platformIcon(device.platform);
                return (
                  <li
                    className="p-4 sm:p-5"
                    key={device.id}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <PlatformIcon
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        />
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="break-words text-sm font-medium text-foreground sm:truncate">
                              {device.name}
                            </p>
                            {statusBadge(device.status)}
                            <Badge
                              className="font-mono capitalize"
                              variant="outline"
                            >
                              {device.platform}
                            </Badge>
                            {device.inventory && (
                              <Badge
                                variant={
                                  device.inventory.syncStatus === "synced" &&
                                  device.inventory.policyRevision ===
                                    device.currentPolicyRevision
                                    ? "success"
                                    : "warning"
                                }
                              >
                                {device.inventory.syncStatus === "error"
                                  ? "Sync needs attention"
                                  : device.inventory.policyRevision !==
                                      device.currentPolicyRevision
                                    ? "Policy sync pending"
                                    : "Tools synced"}
                              </Badge>
                            )}
                          </div>
                          <p className="break-words text-sm text-muted-foreground sm:text-xs">
                            {device.owner.name} · Lori v{device.appVersion}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {device.lastSeenAt ? (
                              <LocalDateTime
                                prefix="Last seen "
                                value={device.lastSeenAt}
                              />
                            ) : (
                              "Not seen since enrollment"
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {device.status !== "revoked" &&
                          (confirming === device.id ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                disabled={pending === device.id}
                                onClick={() => void revoke(device.id)}
                                size="sm"
                                variant="destructive"
                              >
                                <ShieldOffIcon className="size-3.5" />
                                {pending === device.id
                                  ? "Revoking…"
                                  : "Confirm revoke"}
                              </Button>
                              <Button
                                disabled={pending === device.id}
                                onClick={() => setConfirming(null)}
                                size="sm"
                                variant="ghost"
                              >
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <Button
                              onClick={() => setConfirming(device.id)}
                              size="sm"
                              variant="outline"
                            >
                              Revoke access
                            </Button>
                          ))}
                      </div>
                    </div>

                    {device.inventory ? (
                      <details className="group mt-4 border-t border-border pt-3">
                        <summary className="flex min-h-11 cursor-pointer list-none items-start gap-2 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:min-h-0 sm:text-xs">
                          <ChevronDownIcon
                            aria-hidden
                            className="mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-180"
                          />
                          <span>
                            View installed access ({device.inventory.items.length})
                            <span className="mt-1 block font-mono text-xs font-normal text-muted-foreground sm:ml-2 sm:mt-0 sm:inline">
                              Policy revision {device.inventory.policyRevision} · reported{" "}
                              <LocalDateTime value={device.inventory.reportedAt} />
                            </span>
                          </span>
                        </summary>
                        <div className="mt-3 space-y-3">
                          {device.inventory.syncError && (
                            <div className="flex gap-2 rounded-md border border-warning/30 bg-warning-muted p-3 text-sm text-warning-muted-foreground sm:text-xs">
                              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                              <span>{device.inventory.syncError}</span>
                            </div>
                          )}
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            Organization managed means the dashboard controls access. Removing the final managed assignment disables that copy without deleting it. When personal access is allowed, the member may explicitly enable the retained copy again.
                          </p>
                          {device.inventory.items.length === 0 ? (
                            <p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                              This device reported no installed apps, plugins, providers, or skills.
                            </p>
                          ) : (
                            <ul className="divide-y divide-border rounded-md border border-border">
                              {device.inventory.items.map((item) => (
                                <li
                                  className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                                  key={`${item.type}:${item.id}`}
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-xs font-medium text-foreground">
                                        {item.name}
                                      </span>
                                      <Badge variant="outline">{item.type}</Badge>
                                      <Badge
                                        variant={
                                          item.organizationManaged
                                            ? "default"
                                            : "outline"
                                        }
                                      >
                                        {item.organizationManaged
                                          ? "Organization managed"
                                          : "Personal install"}
                                      </Badge>
                                    </div>
                                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                                      {item.id}
                                    </p>
                                  </div>
                                  <p className="shrink-0 text-xs text-muted-foreground">
                                    {item.enabled && item.enabledAgents.length > 0
                                      ? formatAgents(item.enabledAgents)
                                      : "Removed from coding tools"}
                                  </p>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </details>
                    ) : (
                      <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                        Inventory appears after the next desktop sync. Older Lori versions only report connection status.
                      </p>
                    )}
                    {device.workInventory ? <details className="group mt-4 border-t border-border pt-3"><summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronDownIcon aria-hidden className="size-4 group-open:rotate-180" />Work access ({device.workInventory.items.length})</summary><div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">Policy revision {device.workInventory.policyRevision} · reported <LocalDateTime value={device.workInventory.reportedAt} /></p>{device.workInventory.syncStatus === "error" ? <Alert variant="destructive">Work inventory could not synchronize. Refresh enterprise policy on this desktop.</Alert> : null}<ul className="divide-y divide-border">{device.workInventory.items.map(item => <li key={`${item.type}:${item.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{item.name}</span><Badge variant="outline">{item.type}</Badge><span className="text-xs text-muted-foreground">{item.organizationManaged ? "Organization managed" : "Member added"}</span></div><span className="text-xs text-muted-foreground">{item.enabled ? "Available in Work" : "Unavailable in Work"}</span></li>)}</ul>{!device.workInventory.items.length ? <p className="text-sm text-muted-foreground">No Work resources reported.</p> : null}</div></details> : <p className="mt-3 text-xs text-muted-foreground">Work inventory has not been reported by this desktop.</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </Section>
    </div>
  );
}
