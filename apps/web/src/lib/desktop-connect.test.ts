import { describe, expect, it } from "vitest";
import {
  desktopConnectUrl,
  desktopLaunchGuidance,
  usesDevelopmentDesktopHandoff,
} from "./desktop-connect";

describe("desktopConnectUrl", () => {
  it("carries the canonical custom-domain origin without credentials", () => {
    expect(desktopConnectUrl("https://enterprise.acme.com")).toBe(
      "lori://connect?server=https%3A%2F%2Fenterprise.acme.com&protocol=1",
    );
  });

  it("allows localhost HTTP for development", () => {
    expect(desktopConnectUrl("http://localhost:3000")).toBe(
      "lori://connect?server=http%3A%2F%2Flocalhost%3A3000&protocol=1",
    );
  });

  it("uses the running desktop relay for an unpackaged development build", () => {
    expect(desktopConnectUrl("http://localhost:3000", true)).toBe(
      "http://127.0.0.1:43891/connect?server=http%3A%2F%2Flocalhost%3A3000&protocol=1",
    );
  });

  it.each([
    "Not available",
    " https://enterprise.acme.com",
    "http://enterprise.acme.com",
    "https://user:secret@enterprise.acme.com",
    "https://enterprise.acme.com/path",
    "https://enterprise.acme.com/?token=secret",
    "https://enterprise.acme.com/#fragment",
  ])("fails closed for an invalid public origin: %s", (origin) => {
    expect(desktopConnectUrl(origin)).toBeNull();
  });
});

describe("desktopLaunchGuidance", () => {
  it("explains the production fallback without exposing server entry", () => {
    const guidance = desktopLaunchGuidance(false);
    expect(guidance).toMatch(/install or start Lori/i);
    expect(guidance).toMatch(/one browser approval/i);
    expect(guidance).not.toMatch(/server address|copy/i);
  });

  it("explains the development relay without asking the user to handle it", () => {
    const guidance = desktopLaunchGuidance(true);
    expect(guidance).toMatch(/new tab is checking/i);
    expect(guidance).toMatch(/existing connection is confirmed immediately/i);
    expect(guidance).not.toMatch(/127\.0\.0\.1|localhost/i);
  });
});

describe("usesDevelopmentDesktopHandoff", () => {
  it("uses the development listener for a loopback deployment even in a production Docker build", () => {
    expect(usesDevelopmentDesktopHandoff("http://localhost:8180")).toBe(true);
    expect(usesDevelopmentDesktopHandoff("http://127.0.0.1:8180")).toBe(true);
  });

  it("keeps public deployments on the registered Lori protocol", () => {
    expect(usesDevelopmentDesktopHandoff("https://enterprise.acme.com")).toBe(false);
    expect(usesDevelopmentDesktopHandoff("Not available")).toBe(false);
  });
});
