import { describe, expect, it } from "vitest";
import { formatEstimatedCost, formatLocalDateTime } from "./usage-format";

describe("formatEstimatedCost", () => {
  it("does not round a non-zero micro-USD estimate down to zero", () => {
    expect(formatEstimatedCost(250)).toBe("$0.00025");
  });
});

describe("formatLocalDateTime", () => {
  it("uses the viewer timezone and includes its active abbreviation", () => {
    expect(formatLocalDateTime("2026-08-11T13:38:00.000Z", {
      locale: "en-IN",
      timeZone: "Asia/Kolkata",
    })).toBe("11 Aug 2026, 7:08 pm IST");
  });

  it("uses the daylight-saving label active at the event time", () => {
    expect(formatLocalDateTime("2026-08-11T13:38:00.000Z", {
      locale: "en-US",
      timeZone: "America/New_York",
    })).toBe("Aug 11, 2026, 9:38 AM EDT");
  });

  it("handles missing and invalid timestamps safely", () => {
    expect(formatLocalDateTime()).toBe("Not received yet");
    expect(formatLocalDateTime("invalid")).toBe("Not available");
  });
});

it("shows unpriced Work as unavailable and mixed coverage as partial", async () => {
  const { formatCoveredCost } = await import("./usage-format");
  expect(formatCoveredCost({ totalTokens: 50, estimatedCostMicrousd: 0, costCoveragePercent: 0 })).toBe("Unavailable");
  expect(formatCoveredCost({ totalTokens: 50, estimatedCostMicrousd: 100, costCoveragePercent: 50 })).toContain("partial");
  expect(formatCoveredCost({ totalTokens: 50, estimatedCostMicrousd: 0, costCoveragePercent: 100 })).not.toBe("Unavailable");
});
