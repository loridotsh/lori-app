import { describe, expect, it } from "vitest";
import {
  hashToken,
  normalizeEmail,
  readCookie,
  safeTokenMatches,
  signOnboardingClaim,
  verifyOnboardingClaim,
} from "./onboarding.js";

const secret = "test-auth-secret-that-is-at-least-32-characters";

describe("onboarding claims", () => {
  it("normalizes and verifies a signed invitation claim", () => {
    const signed = signOnboardingClaim(
      {
        email: " Person@Example.COM ",
        invitationLinkId: "link-id",
        purpose: "invitation",
      },
      secret,
      1_000,
    );

    expect(verifyOnboardingClaim(signed, secret, 2_000)).toMatchObject({
      email: "person@example.com",
      invitationLinkId: "link-id",
      purpose: "invitation",
    });
  });

  it("rejects tampered and expired claims", () => {
    const signed = signOnboardingClaim(
      { email: "person@example.com", purpose: "setup" },
      secret,
      1_000,
    );

    expect(verifyOnboardingClaim(`${signed}x`, secret, 2_000)).toBeNull();
    expect(verifyOnboardingClaim(signed, secret, 1_000_000)).toBeNull();
  });

  it("compares setup tokens without comparing raw values", () => {
    expect(safeTokenMatches("correct-token", "correct-token")).toBe(true);
    expect(safeTokenMatches("wrong-token", "correct-token")).toBe(false);
    expect(hashToken("secret")).not.toContain("secret");
  });

  it("reads an encoded cookie without confusing sibling cookie names", () => {
    expect(
      readCookie("other=value; lori_onboarding=a%2Eb; final=1", "lori_onboarding"),
    ).toBe("a.b");
    expect(readCookie("lori_onboarding_extra=x", "lori_onboarding")).toBeUndefined();
  });

  it("treats malformed cookie encoding as an invalid cookie", () => {
    expect(readCookie("lori_onboarding=%E0%A4%A", "lori_onboarding")).toBeUndefined();
  });

  it("normalizes email addresses consistently", () => {
    expect(normalizeEmail("  Admin@Acme.COM ")).toBe("admin@acme.com");
  });
});
