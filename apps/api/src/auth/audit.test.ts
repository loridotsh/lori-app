import { describe, expect, it, vi } from "vitest";
import { auditEventsCsv, recordAuditEvent } from "./audit.js";

describe("audit export", () => {
  it.each(["\t=1+1", "\r=1+1", "\n+1+1", "  @SUM(1)", "\u0000-1+1", "\ttext"])(
    "neutralizes spreadsheet control prefixes: %j", (name) => {
      const csv = auditEventsCsv([{
        id: "event", action: "session.created", createdAt: "2026-10-22T00:00:00Z",
        actor: { id: "user", email: "member@example.test", name }, metadata: {},
      }]);
      expect(csv).toContain(`"'${name}"`);
    },
  );
  it("escapes spreadsheet formulas, quotes, commas, and newlines", () => {
    const csv = auditEventsCsv([
      {
        action: "team.policy_updated",
        actor: { email: "admin@example.com", id: "user-1", name: "=Admin" },
        createdAt: "2026-07-31T10:00:00.000Z",
        id: "event-1",
        metadata: { note: "line one\nline two" },
        subjectId: "team-1",
        subjectType: "team",
      },
    ]);

    expect(csv).toContain('"\'=Admin"');
    expect(csv).toContain('"{\""note\"":\""line one\\nline two\""}"');
    expect(csv.split("\n")[0]).toBe(
      "Timestamp,Action,Actor,Actor email,Subject type,Subject ID,Metadata",
    );
  });
});

describe("audit organization scoping", () => {
  it("persists the organization supplied by the mutating service", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordAuditEvent({ query } as never, {
      action: "team.policy_updated",
      actorUserId: "user-1",
      organizationId: "organization-2",
      subjectId: "team-1",
      subjectType: "team",
    });

    expect(query.mock.calls[0]?.[1]?.[3]).toBe("organization-2");
  });
});
