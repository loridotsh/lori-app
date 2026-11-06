import { describe, expect, it } from "vitest";
import { apiFailureDestination } from "./api-failure-destination";

describe("apiFailureDestination", () => {
  it("sends expired sessions back to sign in", () => {
    expect(apiFailureDestination(401)).toBe("/sign-in");
    expect(apiFailureDestination(503, 401)).toBe("/sign-in");
  });

  it("keeps authorization failures separate from service outages", () => {
    expect(apiFailureDestination(403)).toBe("/unauthorized");
    expect(apiFailureDestination(404)).toBe("/unauthorized");
    expect(apiFailureDestination(503)).toBe("/service-unavailable");
  });
});
