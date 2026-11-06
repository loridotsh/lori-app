import type { DesktopPlatform } from "@lori-enterprise/contracts";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/auth-frame";
import { Alert } from "@/components/ui/alert";
import { apiFailureDestination } from "@/lib/api-failure-destination";
import { getViewer, getWorkspaces } from "@/lib/server-api";
import { ConnectApproval } from "./connect-approval";

export const dynamic = "force-dynamic";

interface ConnectParameters {
  app_version?: string;
  callback_url?: string;
  challenge?: string;
  device_name?: string;
  platform?: string;
  state?: string;
}

const challengePattern = /^[A-Za-z0-9_-]{43}$/;
const statePattern = /^[A-Za-z0-9\-._~]{16,256}$/;
const appVersionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/;
const deviceNamePattern = /^[^\u0000-\u001F\u007F]{1,80}$/;
const callbackTokenPattern = /^\/enroll\/[A-Za-z0-9_-]{43}$/;

function platform(value: string | undefined): DesktopPlatform | null {
  return value === "macos" || value === "windows" || value === "linux"
    ? value
    : null;
}

function callbackPath(parameters: ConnectParameters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value) {
      query.set(key, value);
    }
  }
  return `/connect?${query.toString()}`;
}

function loopbackCallback(value: string | undefined): string | null {
  if (!value || value.length > 256) return null;
  try {
    const callback = new URL(value);
    const port = Number(callback.port);
    return callback.protocol === "http:" &&
      callback.hostname === "127.0.0.1" &&
      Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65_535 &&
      callback.username === "" &&
      callback.password === "" &&
      callback.search === "" &&
      callback.hash === "" &&
      callbackTokenPattern.test(callback.pathname)
      ? callback.toString()
      : null;
  } catch {
    return null;
  }
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<ConnectParameters>;
}) {
  const parameters = await searchParams;
  const desktopPlatform = platform(parameters.platform);
  const desktopCallback = loopbackCallback(parameters.callback_url);
  const valid =
    Boolean(
      parameters.app_version &&
        appVersionPattern.test(parameters.app_version.trim()),
    ) &&
    Boolean(
      parameters.device_name &&
        deviceNamePattern.test(parameters.device_name.trim()),
    ) &&
    Boolean(parameters.challenge && challengePattern.test(parameters.challenge)) &&
    Boolean(parameters.state && statePattern.test(parameters.state)) &&
    Boolean(desktopPlatform) &&
    (!parameters.callback_url || Boolean(desktopCallback));

  if (!valid || !desktopPlatform) {
    return (
      <AuthFrame
        description="Lori desktop did not provide a valid enrollment request."
        title="Connection request invalid"
      >
        <Alert variant="destructive">
          Return to Lori desktop and start the organization connection again.
          This request may be incomplete or from an unsupported app version.
        </Alert>
      </AuthFrame>
    );
  }

  const [{ status, viewer }, { workspaces }] = await Promise.all([
    getViewer(),
    getWorkspaces(),
  ]);
  if (!viewer) {
    // Someone with no workspace yet makes one, then returns to this request.
    if (status === 403 && workspaces?.canCreate) {
      redirect(`/get-started?callback=${encodeURIComponent(callbackPath(parameters))}`);
    }
    const destination = apiFailureDestination(status);
    if (destination !== "/sign-in") {
      redirect(destination);
    }
    redirect(`/sign-in?callback=${encodeURIComponent(callbackPath(parameters))}`);
  }

  return (
    <AuthFrame
      cloud={viewer.cloud}
      description="You’re signed in. Confirm this device once to finish the secure connection."
      title="Approve this Lori device"
    >
      <ConnectApproval
        workspaces={workspaces?.workspaces ?? []}
        appVersion={parameters.app_version!.trim()}
        callbackUrl={desktopCallback ?? undefined}
        codeChallenge={parameters.challenge!}
        deviceName={parameters.device_name!.trim()}
        platform={desktopPlatform}
        state={parameters.state!}
        viewer={viewer}
      />
    </AuthFrame>
  );
}
