import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresPolicyUpdates } from "./policy-updates.js";

function harness() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  }) as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { broker: new PostgresPolicyUpdates(pool), client };
}

describe("PostgresPolicyUpdates", () => {
  it("fans a committed organization policy revision out to matching devices", async () => {
    const { broker, client } = harness();
    await broker.start();
    const scope = { deviceId: "device-1", organizationId: "org-1" };
    const waiting = broker.waitForChange(scope, broker.snapshot(), 1_000);

    client.emit("notification", {
      channel: "lori_desktop_updates",
      payload: JSON.stringify({
        deviceId: "*",
        kind: "policy",
        organizationId: "org-1",
        revision: 8,
      }),
      processId: 1,
    });

    await expect(waiting).resolves.toMatchObject({
      kind: "policy",
      revision: 8,
    });
    await broker.close();
  });

  it("keeps revocation notifications scoped to the affected device", async () => {
    const { broker, client } = harness();
    await broker.start();
    const unaffected = { deviceId: "device-1", organizationId: "org-1" };
    const revoked = { deviceId: "device-2", organizationId: "org-1" };
    const controller = new AbortController();
    const unaffectedWait = broker.waitForChange(
      unaffected,
      broker.snapshot(),
      1_000,
      controller.signal,
    );
    const revokedWait = broker.waitForChange(
      revoked,
      broker.snapshot(),
      1_000,
    );

    client.emit("notification", {
      channel: "lori_desktop_updates",
      payload: JSON.stringify({
        deviceId: "device-2",
        kind: "access_revoked",
        organizationId: "org-1",
      }),
      processId: 1,
    });

    await expect(revokedWait).resolves.toMatchObject({
      deviceId: "device-2",
      kind: "access_revoked",
    });
    controller.abort();
    await expect(unaffectedWait).resolves.toBeNull();
    await broker.close();
  });

  it("does not miss a notification delivered between snapshot and wait", async () => {
    const { broker, client } = harness();
    await broker.start();
    const scope = { deviceId: "device-1", organizationId: "org-1" };
    const sequence = broker.snapshot();
    client.emit("notification", {
      channel: "lori_desktop_updates",
      payload: JSON.stringify({
        deviceId: "*",
        kind: "policy",
        organizationId: "org-1",
        revision: 9,
      }),
      processId: 1,
    });

    await expect(
      broker.waitForChange(scope, sequence, 1_000),
    ).resolves.toMatchObject({ revision: 9 });
    await broker.close();
  });

  it("bounds concurrent waits from one device", async () => {
    const { broker } = harness();
    await broker.start();
    const scope = { deviceId: "device-1", organizationId: "org-1" };
    const first = new AbortController();
    const second = new AbortController();
    const firstWait = broker.waitForChange(
      scope,
      broker.snapshot(),
      1_000,
      first.signal,
    );
    const secondWait = broker.waitForChange(
      scope,
      broker.snapshot(),
      1_000,
      second.signal,
    );

    await expect(
      broker.waitForChange(scope, broker.snapshot(), 1_000),
    ).rejects.toMatchObject({ name: "PolicyUpdateCapacityError" });
    first.abort();
    second.abort();
    await expect(firstWait).resolves.toBeNull();
    await expect(secondWait).resolves.toBeNull();
    await broker.close();
  });
});
