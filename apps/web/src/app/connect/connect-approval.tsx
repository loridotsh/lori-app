"use client";

import type {
  DesktopPlatform,
  EnrollmentAuthorization,
  Viewer,
  Workspace,
} from "@lori-enterprise/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LaptopIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspaceSelect } from "@/components/workspace-select";
import { ClientApiError, clientApi } from "@/lib/client-api";
import { onWorkspaceChange } from "@/lib/workspace-channel";

const PLATFORM_NAMES: Record<DesktopPlatform, string> = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
};

interface ApprovalError {
  message: string;
  sessionExpired: boolean;
}

function approvalError(error: unknown): ApprovalError {
  if (error instanceof ClientApiError) {
    if (error.status === 401) {
      return {
        message: "Your dashboard session expired before approval.",
        sessionExpired: true,
      };
    }
    if (error.status === 403) {
      return {
        message:
          "This account no longer has permission to connect a Lori device for this organization.",
        sessionExpired: false,
      };
    }
    if (error.code === "workspace_changed") {
      return { message: error.message, sessionExpired: false };
    }
    if (error.status === 409) {
      return {
        message:
          "This connection request is no longer active. Return to Lori and start again.",
        sessionExpired: false,
      };
    }
    if (error.status === 429) {
      return {
        message:
          "Too many connection attempts were made. Wait a moment, then try again.",
        sessionExpired: false,
      };
    }
    if (error.status >= 500) {
      return {
        message:
          "Lori Enterprise could not approve this device right now. Your device is not connected; try again shortly.",
        sessionExpired: false,
      };
    }
  }
  return {
    message:
      "The connection could not be approved. Check your network and try again.",
    sessionExpired: false,
  };
}

function connectionPath({
  appVersion,
  callbackUrl,
  codeChallenge,
  deviceName,
  platform,
  state,
}: {
  appVersion: string;
  callbackUrl?: string;
  codeChallenge: string;
  deviceName: string;
  platform: DesktopPlatform;
  state: string;
}): string {
  const query = new URLSearchParams({
    app_version: appVersion,
    challenge: codeChallenge,
    device_name: deviceName,
    platform,
    state,
  });
  if (callbackUrl) query.set("callback_url", callbackUrl);
  return `/connect?${query.toString()}`;
}

export function ConnectApproval({
  appVersion,
  callbackUrl,
  codeChallenge,
  deviceName,
  platform,
  state,
  viewer,
  workspaces = [],
}: {
  appVersion: string;
  callbackUrl?: string;
  codeChallenge: string;
  deviceName: string;
  platform: DesktopPlatform;
  state: string;
  viewer: Viewer;
  workspaces?: Workspace[];
}) {
  const [authorization, setAuthorization] =
    useState<EnrollmentAuthorization | null>(null);
  const [error, setError] = useState<ApprovalError | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const approvalController = useRef<AbortController | null>(null);
  const approvalPending = useRef(false);
  const requestFingerprint = `${codeChallenge.slice(0, 6)}…${codeChallenge.slice(-6)}`;
  const signInCallback = `/sign-in?callback=${encodeURIComponent(
    connectionPath({
      appVersion,
      callbackUrl,
      codeChallenge,
      deviceName,
      platform,
      state,
    }),
  )}`;

  // What this page shows must be where the device lands.
  useEffect(() => onWorkspaceChange(() => window.location.reload()), []);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
      approvalController.current?.abort();
    },
    [],
  );

  async function approve() {
    if (approvalPending.current) return;
    approvalPending.current = true;
    const controller = new AbortController();
    approvalController.current = controller;
    setError(null);
    setPending(true);
    try {
      const result = await clientApi<EnrollmentAuthorization>(
        "/v1/enrollment/authorize",
        {
          body: JSON.stringify({
            appVersion,
            ...(callbackUrl ? { callbackUrl } : {}),
            codeChallenge,
            deviceName,
            expectedOrganizationId: viewer.organization.id,
            platform,
            state,
          }),
          method: "POST",
          signal: controller.signal,
        },
      );
      setAuthorization(result);
      try {
        window.location.assign(result.returnUrl ?? result.deepLink);
      } catch {
        setError({
          message:
            "This device was approved, but the browser could not return to Lori automatically. Use the connection button below.",
          sessionExpired: false,
        });
      }
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setError(approvalError(requestError));
      }
    } finally {
      approvalPending.current = false;
      if (approvalController.current === controller) {
        approvalController.current = null;
      }
      if (!controller.signal.aborted) {
        setPending(false);
      }
    }
  }

  if (authorization) {
    const completionUrl = authorization.returnUrl ?? authorization.deepLink;
    return (
      <div className="space-y-4">
        {error && <Alert variant="destructive">{error.message}</Alert>}
        <Alert variant="success">
          Connection approved. Lori should finish automatically. This one-time
          approval expires at{" "}
          {new Date(authorization.expiresAt).toLocaleTimeString()}.
        </Alert>
        <Button asChild className="w-full" size="lg">
          <a href={completionUrl}>
            <ExternalLinkIcon className="size-4" />
            {authorization.returnUrl
              ? "Finish connection"
              : "Open Lori desktop"}
          </a>
        </Button>
        <Button
          className="w-full"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(authorization.deepLink);
              setCopied(true);
              if (copiedTimer.current !== null) {
                window.clearTimeout(copiedTimer.current);
              }
              copiedTimer.current = window.setTimeout(
                () => setCopied(false),
                1_500,
              );
            } catch {
              setError({
                message:
                  "The return link could not be copied. Use the connection button instead.",
                sessionExpired: false,
              });
            }
          }}
          variant="outline"
        >
          {copied ? (
            <CheckIcon className="size-4 text-success" />
          ) : (
            <CopyIcon className="size-4" />
          )}
          {copied ? "Link copied" : "Copy return link"}
        </Button>
        <Button asChild className="w-full" variant="ghost">
          <Link href="/devices">Review connected devices</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <div className="space-y-3">
            <p>{error.message}</p>
            {error.sessionExpired ? (
              <Button asChild size="sm" variant="outline">
                <Link href={signInCallback}>Sign in again</Link>
              </Button>
            ) : null}
          </div>
        </Alert>
      )}

      <Alert variant="success">
        <div className="flex items-start gap-2.5">
          <CircleCheckIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0"
          />
          <div className="min-w-0">
            <p className="font-medium">Signed in as {viewer.user.email}</p>
            <p className="mt-0.5 text-xs leading-relaxed">
              One confirmation remains because this request gives a desktop
              installation access to{" "}
              {viewer.organization.kind === "personal"
                ? "your workspace"
                : "your organization"}
              .
            </p>
          </div>
        </div>
      </Alert>

      <div className="flex items-start gap-3">
        <LaptopIcon
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{deviceName}</p>
            <Badge variant="outline">{PLATFORM_NAMES[platform]}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Lori {appVersion}
          </p>
        </div>
      </div>

      {workspaces.length > 1 && (
        <WorkspaceSelect label="Connect to" workspaces={workspaces} />
      )}

      <dl className="divide-y divide-border border-y border-border text-sm">
        {workspaces.length <= 1 && (
          <div className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">
              {viewer.organization.kind === "personal" ? "Workspace" : "Organization"}
            </dt>
            <dd className="truncate text-right font-medium text-foreground">
              {viewer.organization.name}
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-4 py-2.5">
          <dt className="text-muted-foreground">Request fingerprint</dt>
          <dd className="font-mono text-right font-medium text-foreground">
            {requestFingerprint}
          </dd>
        </div>
      </dl>

      <Alert>
        Confirm only if you chose Open Lori from this dashboard and the device
        details above match. This approval is required once for each new Lori
        installation.
      </Alert>

      <Button
        className="w-full"
        disabled={pending}
        onClick={() => void approve()}
        size="lg"
      >
        {pending ? "Approving device…" : "Approve and connect Lori"}
      </Button>
      <Button asChild className="w-full" variant="ghost">
        <Link
          href="/"
          onClick={() => {
            approvalController.current?.abort();
          }}
        >
          <ArrowLeftIcon className="size-4" />
          Not this device
        </Link>
      </Button>
    </div>
  );
}
