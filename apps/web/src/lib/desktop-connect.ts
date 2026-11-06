import { DESKTOP_PROTOCOL_VERSION } from "@lori-enterprise/contracts";

export const DEVELOPMENT_DESKTOP_LAUNCH_ORIGIN = "http://127.0.0.1:43891";

function canonicalPublicUrl(publicUrl: string): URL | null {
  if (!publicUrl || publicUrl.trim() !== publicUrl) return null;

  try {
    const server = new URL(publicUrl);
    const localhost =
      server.hostname === "localhost" ||
      server.hostname === "127.0.0.1" ||
      server.hostname === "[::1]";
    const validProtocol =
      server.protocol === "https:" ||
      (server.protocol === "http:" && localhost);
    if (
      !validProtocol ||
      server.username ||
      server.password ||
      server.pathname !== "/" ||
      server.search ||
      server.hash
    ) {
      return null;
    }
    return server;
  } catch {
    return null;
  }
}

export function usesDevelopmentDesktopHandoff(publicUrl: string): boolean {
  const server = canonicalPublicUrl(publicUrl);
  return Boolean(
    server &&
      (server.hostname === "localhost" ||
        server.hostname === "127.0.0.1" ||
        server.hostname === "[::1]"),
  );
}

export function desktopLaunchGuidance(development: boolean): string {
  return development
    ? "The new tab is checking your running Lori app. If Lori is not running, start it and choose Open Lori again. A new installation requires one browser approval; an existing connection is confirmed immediately."
    : "Lori should open automatically. If nothing happens, install or start Lori and choose Open Lori again. A new installation requires one browser approval; an existing connection needs none.";
}

export function desktopConnectUrl(
  publicUrl: string,
  development = false,
): string | null {
  const server = canonicalPublicUrl(publicUrl);
  if (!server) return null;
  try {
    const link = new URL(
      development
        ? `${DEVELOPMENT_DESKTOP_LAUNCH_ORIGIN}/connect`
        : "lori://connect",
    );
    link.searchParams.set("server", server.origin);
    link.searchParams.set("protocol", String(DESKTOP_PROTOCOL_VERSION));
    return link.toString();
  } catch {
    return null;
  }
}
