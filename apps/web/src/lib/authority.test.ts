import type { Viewer } from "@lori-enterprise/contracts";
import { organizationCapabilities } from "@lori-enterprise/contracts";
import { expect, it } from "vitest";
import { authoritySignature } from "@/hooks/use-authority-refresh";
import { canDo, isAdministrator, roleLabel } from "./authority";
import { manageDestination } from "./manage-destination";

const viewer = (role: Viewer["role"], revision = 1): Viewer => ({
  organization: { id: "org", name: "Acme" },
  role,
  authority: { role, capabilities: organizationCapabilities(role), revision, ownerAssigned: true },
  user: { id: "u", name: "U", email: "u@example.test" },
});

it("treats the owner as an organization administrator everywhere", () => {
  expect(isAdministrator(viewer("owner"))).toBe(true);
  expect(isAdministrator(viewer("admin"))).toBe(true);
  expect(isAdministrator(viewer("member"))).toBe(false);
  expect(manageDestination({ viewer: viewer("owner"), admin: false })).toEqual({ href: "/", label: "Manage organization" });
  expect(roleLabel("owner")).toBe("Owner");
});

it("uses the server capability snapshot for owner-only actions", () => {
  expect(canDo(viewer("owner"), "admins.manage")).toBe(true);
  expect(canDo(viewer("admin"), "admins.manage")).toBe(false);
  // A stale or narrowed snapshot wins over the role's defaults.
  expect(canDo({ ...viewer("owner"), authority: { ...viewer("owner").authority!, capabilities: [] } }, "admins.manage")).toBe(false);
});

it("refreshes on authority changes but not on ordinary policy revisions", () => {
  expect(authoritySignature(viewer("admin", 1))).toBe(authoritySignature(viewer("admin", 9)));
  expect(authoritySignature(viewer("admin"))).not.toBe(authoritySignature(viewer("owner")));
});
