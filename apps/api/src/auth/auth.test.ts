import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { authorizeSignup, organizationIdForUser } from "./auth.js";
import {
  ONBOARDING_COOKIE,
  signOnboardingClaim,
} from "./onboarding.js";

const config = {
  auth: {
    secret: "test-auth-secret-that-is-at-least-32-characters",
    secureCookies: false,
    setupToken: "test-setup-token-that-is-at-least-32-characters",
  },
} as AppConfig;

describe("invite-only sign-up authorization", () => {
  it("denies direct sign-up without an onboarding claim", async () => {
    const database = { query: vi.fn() } as unknown as Pick<Pool, "query">;
    await expect(
      authorizeSignup(database, config, "person@example.com", undefined),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(database.query).not.toHaveBeenCalled();
  });

  it("accepts a setup claim only for the bound email", async () => {
    const claim = signOnboardingClaim(
      { email: "admin@example.com", purpose: "setup" },
      config.auth.secret,
    );
    const cookie = `${ONBOARDING_COOKIE}=${encodeURIComponent(claim)}`;
    const database = { query: vi.fn() } as unknown as Pick<Pool, "query">;

    await expect(
      authorizeSignup(database, config, "ADMIN@example.com", cookie),
    ).resolves.toBe("admin@example.com");
    await expect(
      authorizeSignup(database, config, "other@example.com", cookie),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("rechecks invitation state before allowing account creation", async () => {
    const claim = signOnboardingClaim(
      {
        email: "member@example.com",
        invitationLinkId: "link-id",
        purpose: "invitation",
      },
      config.auth.secret,
    );
    const cookie = `${ONBOARDING_COOKIE}=${encodeURIComponent(claim)}`;
    const active = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [{}] })),
    } as unknown as Pick<Pool, "query">;
    const revoked = {
      query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
    } as unknown as Pick<Pool, "query">;

    await expect(
      authorizeSignup(active, config, "member@example.com", cookie),
    ).resolves.toBe("member@example.com");
    await expect(
      authorizeSignup(revoked, config, "member@example.com", cookie),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });
});

describe("organizationIdForUser", () => {
  it("resolves the actor's organization from their membership", async () => {
    const query = vi.fn(async () => ({
      rows: [{ organization_id: "organization-1" }],
    }));
    const database = { query } as unknown as Pick<Pool, "query">;

    await expect(
      organizationIdForUser(database, "user-1"),
    ).resolves.toBe("organization-1");
    expect(query).toHaveBeenCalledWith(
      expect.any(String),
      ["user-1"],
    );
  });

  it("returns null for someone in several organizations, so a sign-in is never misfiled", async () => {
    const query = vi.fn(async () => ({
      rows: [{ organization_id: "organization-1" }, { organization_id: "organization-2" }],
    }));
    const database = { query } as unknown as Pick<Pool, "query">;

    await expect(
      organizationIdForUser(database, "user-1"),
    ).resolves.toBeNull();
  });

  it("returns null when the user has no membership yet (pre-setup sign-in)", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const database = { query } as unknown as Pick<Pool, "query">;

    await expect(
      organizationIdForUser(database, "user-1"),
    ).resolves.toBeNull();
  });
});
