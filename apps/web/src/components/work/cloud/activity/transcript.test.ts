import { describe, expect, it } from "vitest";
import type { CloudMessage, CloudRun, CloudToolInvocation } from "@lori-enterprise/contracts";
import { buildTranscript } from "./transcript";
const run: CloudRun = { id: "run", conversationId: "conv", status: "running", gatewayId: "g", modelId: "m", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", lastSequence: 1, errorCode: null };
const user: CloudMessage = { id: "user", runId: "run", runStatus: "running", role: "user", text: "Compare", createdAt: run.createdAt };
const assistant: CloudMessage = { ...user, id: "assistant", role: "assistant", runStatus: "completed", text: "Done" };
const invocation = { runId: "run" } as CloudToolInvocation;

describe("response identity during reconciliation", () => {
  it("retains the same response key from pending to live tools to saved text", () => {
    const pending = buildTranscript([user], [], run);
    const live = buildTranscript([user], [invocation], run, "Live");
    const saved = buildTranscript([user, assistant], [invocation]);
    expect(pending.map(e => e.key)).toEqual(["user:user", "response:run"]);
    expect(live.map(e => e.key)).toEqual(saved.map(e => e.key));
    expect(saved[1]).toMatchObject({ type: "response", text: "Done", active: false });
  });
  it("renders tool-only responses once and preserves following turns", () => {
    const nextUser = { ...user, id: "next-user", runId: "next-run" };
    expect(buildTranscript([user, nextUser], [invocation]).map(e => e.key)).toEqual(["user:user", "response:run", "user:next-user"]);
    expect(buildTranscript([user, assistant], [invocation])).toHaveLength(2);
  });
  it("handles historical assistant-only messages and an active snapshot before its user loads", () => {
    expect(buildTranscript([assistant], [invocation])).toHaveLength(1);
    expect(buildTranscript([], [], run, "Hello")[0]).toMatchObject({ key: "response:run", text: "Hello", active: true });
    expect(buildTranscript([user], [])).toHaveLength(1);
  });
});
