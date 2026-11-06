import type { Viewer } from "@lori-enterprise/contracts";
import { expect, it } from "vitest";
import { accountName } from "./account-menu";

const viewer: Viewer = {
  role: "member",
  user: { id: "u", name: "Piyush Sharma", email: "piyush@example.com" },
  organization: { id: "o", name: "Ashish" },
};

it("names the signed-in user, never the organization", () => {
  expect(accountName(viewer)).toBe("Piyush Sharma");
});

it("falls back to the email when the account has no name", () => {
  expect(accountName({ ...viewer, user: { ...viewer.user, name: "  " } })).toBe("piyush@example.com");
});
