import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_POLICY, resolveProjectAccess } from "./policy.js";
const base = { policy: DEFAULT_PROJECT_POLICY, status: "active" as const, accessRevision: 1, blocked: false };
describe("project permission boundary", () => {
  it("never grants content from an administrator flag alone", () => {
    expect(resolveProjectAccess({ ...base, grants: [] }).actions).toEqual([]);
  });
  it("blocks every grant, including audited administration", () => {
    expect(resolveProjectAccess({ ...base, blocked: true, audited: true, grants: [{ role: "manager", deniedActions: [] }] }).actions).toEqual([]);
  });
  it("keeps explicit restrictions when another team grants a stronger role", () => {
    const access = resolveProjectAccess({ ...base, grants: [{ role: "viewer", deniedActions: ["export"] }, { role: "manager", deniedActions: [] }] });
    expect(access.actions).toContain("files.write");
    expect(access.actions).not.toContain("export");
    expect(access.actions).not.toContain("tools.write");
    expect(access.actions).not.toContain("members.manage");
  });
  it("makes audit access read-only and archive non-mutating", () => {
    expect(resolveProjectAccess({ ...base, audited: true, grants: [] }).actions).toEqual(["read"]);
    expect(resolveProjectAccess({ ...base, status: "archived", grants: [{ role: "manager", deniedActions: [] }] }).actions).toEqual(["read", "export"]);
  });
  it("does not allow actions without the common read boundary", () => {
    expect(resolveProjectAccess({ ...base, grants: [{ role: "manager", deniedActions: ["read"] }] }).actions).toEqual([]);
  });
});
