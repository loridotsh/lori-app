import { render, screen } from "@testing-library/react";
import type { AuditEventsResponse } from "@lori-enterprise/contracts";
import { describe, expect, it } from "vitest";
import { AuditEventsList } from "./audit-events-list";

const response: AuditEventsResponse = {
  events: [
    {
      action: "team.policy_updated",
      actor: { email: "admin@example.com", id: "user-1", name: "Ada Admin" },
      createdAt: "2026-07-31T09:00:00.000Z",
      id: "event-1",
      metadata: { revision: 22 },
      subjectId: "team-1",
      subjectType: "team",
    },
  ],
  pageInfo: { hasMore: false, limit: 50, offset: 0, total: 1 },
};

describe("AuditEventsList", () => {
  it("explains who changed which enterprise resource", () => {
    render(<AuditEventsList action="" query="" response={response} />);

    expect(screen.getAllByText("Team policy updated")).toHaveLength(2);
    expect(screen.getByText("Ada Admin")).toBeTruthy();
    expect(screen.getByText("admin@example.com")).toBeTruthy();
    expect(screen.getByText("team · team-1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Export CSV" })).toBeTruthy();
  });
});
