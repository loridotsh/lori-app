import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readLease, signLease, secureEqual } from "./security.js";
describe("Cloud lease authentication", () => {
  const secret = "test-worker-secret-that-is-long-enough";
  const claims = {
    runId: randomUUID(),
    leaseId: randomUUID(),
    leaseVersion: 1,
    organizationId: "org",
    memberId: "member",
  };
  it("authenticates a run-specific lease and rejects tampering or a different secret", () => {
    const token = signLease(secret, claims);
    expect(readLease(secret, `Bearer ${token}`)).toEqual(claims);
    expect(() => readLease("different-secret", `Bearer ${token}`)).toThrow();
    expect(() => readLease(secret, `Bearer ${token.slice(0, -1)}!`)).toThrow();
    expect(() => readLease(secret, token)).toThrow();
  });
  it("fails closed when the worker secret is absent", () => {
    expect(() => readLease("", `Bearer ${signLease("", claims)}`)).toThrow();
  });
  it("rejects malformed, extra or unbounded claims even when signed", () => {
    expect(() =>
      readLease(
        secret,
        `Bearer ${signLease(secret, { ...claims, leaseVersion: 0 })}`,
      ),
    ).toThrow();
    expect(() =>
      readLease(
        secret,
        `Bearer ${signLease(secret, { ...claims, organizationId: "x".repeat(4096) })}`,
      ),
    ).toThrow();
    expect(secureEqual("a", "aa")).toBe(false);
  });
});
