import { describe, expect, it } from "vitest";
import {
  desktopPolicyEtag,
  generateDesktopToken,
  hashDesktopToken,
  pkceChallenge,
  readBearerToken,
  verifyPkce,
} from "./desktop-tokens.js";

const secret = "test-secret-that-is-long-enough-for-hmac-domains";

describe("desktop enrollment tokens", () => {
  it("generates opaque purpose-prefixed 256-bit tokens", () => {
    expect(generateDesktopToken("access")).toMatch(/^lea_[A-Za-z0-9_-]{43}$/);
    expect(generateDesktopToken("authorization-code")).toMatch(
      /^lec_[A-Za-z0-9_-]{43}$/,
    );
    expect(generateDesktopToken("refresh")).toMatch(/^ler_[A-Za-z0-9_-]{43}$/);
  });

  it("domain-separates stored token hashes", () => {
    const token = "same-secret-value";
    expect(hashDesktopToken(token, secret, "access")).not.toBe(
      hashDesktopToken(token, secret, "refresh"),
    );
    expect(hashDesktopToken(token, secret, "access")).toHaveLength(64);
  });

  it("verifies PKCE S256 and rejects a different verifier", () => {
    const verifier =
      "fM0n_UFwFBzTjd2yuLzSxKpJHlY6YpQJ3BcdZJw5n-JyiKJTXqgnV5g0-Kx5j0Ek";
    const challenge = pkceChallenge(verifier);
    expect(challenge).toHaveLength(43);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
  });

  it("accepts only a well-formed bearer credential", () => {
    const token = generateDesktopToken("access");
    expect(readBearerToken(`Bearer ${token}`)).toBe(token);
    expect(readBearerToken(`Basic ${token}`)).toBeNull();
    expect(readBearerToken("Bearer short")).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
  });

  it("creates a stable quoted policy ETag", () => {
    expect(desktopPolicyEtag(12)).toBe('"lori-policy-v1-12"');
  });
});
