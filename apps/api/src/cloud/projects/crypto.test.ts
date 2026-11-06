import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProjectKeyring, sealProjectValue, openProjectValue, projectPathKey } from "./crypto.js";
describe("project encrypted storage", () => {
  const old = randomBytes(32).toString("base64url"), next = randomBytes(32).toString("base64url");
  const ring = new ProjectKeyring({ active: "old", keys: { old } });
  it("binds ciphertext to organization, project, entity, identifier and field", () => {
    const { context, wrapped } = ring.create("organization", "project");
    const sealed = sealProjectValue(context, "message", "one", "text", "client-secret-identity");
    expect(JSON.stringify(sealed)).not.toContain("client-secret-identity");
    expect(openProjectValue(context, "message", "one", "text", sealed)).toBe("client-secret-identity");
    for (const changed of [{ ...context, projectId: "other" }, { ...context, organizationId: "other" }])
      expect(() => openProjectValue(changed, "message", "one", "text", sealed)).toThrow();
    expect(() => openProjectValue(context, "message", "two", "text", sealed)).toThrow();
    expect(() => openProjectValue(context, "message", "one", "title", sealed)).toThrow();
    expect(() => ring.unwrap("other", "project", wrapped)).toThrow();
  });
  it("rejects tampering and uses fresh nonces for identical plaintext", () => {
    const { context } = ring.create("org", "project");
    const a = sealProjectValue(context, "memory", "id", "content", { text: "same" });
    const b = sealProjectValue(context, "memory", "id", "content", { text: "same" });
    expect(a.nonce).not.toBe(b.nonce);
    expect(() => openProjectValue(context, "memory", "id", "content", { ...a, tag: b.tag })).toThrow();
  });
  it("rotates wrapping keys without losing content and isolates path digests", () => {
    const { context, wrapped } = ring.create("org", "project");
    const rotated = new ProjectKeyring({ active: "next", keys: { old, next } });
    const rewrapped = rotated.wrap(rotated.unwrap("org", "project", wrapped));
    expect(rewrapped.key).toBe("next");
    expect(rotated.unwrap("org", "project", rewrapped).key.equals(context.key)).toBe(true);
    expect(projectPathKey(context, "case.docx")).not.toBe(projectPathKey(ring.create("org", "other").context, "case.docx"));
    expect(() => new ProjectKeyring({ active: "missing", keys: { old } })).toThrow();
  });
});
