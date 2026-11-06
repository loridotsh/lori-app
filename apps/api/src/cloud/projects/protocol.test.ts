import { expect, it } from "vitest";
import { requireDesktopProjectProtocol } from "./protocol.js";
it("admits the supported desktop project protocol", () => {
  expect(() => requireDesktopProjectProtocol({ "x-lori-project-client-version": "1" })).not.toThrow();
});
it.each([undefined,"0","2",["1","2"]])("rejects unsupported and ambiguous project versions", value => {
  expect(() => requireDesktopProjectProtocol({ "x-lori-project-client-version": value })).toThrow();
});
