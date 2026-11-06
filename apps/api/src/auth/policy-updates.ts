import type { Notification, Pool, PoolClient } from "pg";

const POLICY_UPDATE_CHANNEL = "lori_desktop_updates";
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_PENDING_WAITS = 10_000;
const MAX_PENDING_WAITS_PER_DEVICE = 2;

export class PolicyUpdateCapacityError extends Error {
  public constructor() {
    super("The desktop live-update channel is at capacity.");
    this.name = "PolicyUpdateCapacityError";
  }
}

export interface DesktopUpdateScope {
  deviceId: string;
  organizationId: string;
}

export interface DesktopUpdateNotification extends DesktopUpdateScope {
  kind: "access_revoked" | "policy";
  revision?: number;
  sequence: number;
}

export interface DesktopPolicyUpdates {
  close(): Promise<void>;
  snapshot(): number;
  waitForChange(
    scope: DesktopUpdateScope,
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DesktopUpdateNotification | null>;
}

interface PendingWaiter {
  afterSequence: number;
  finish: (notification: DesktopUpdateNotification | null) => void;
  scope: DesktopUpdateScope;
}

function parseNotification(
  notification: Notification,
): Omit<DesktopUpdateNotification, "sequence"> | null {
  if (notification.channel !== POLICY_UPDATE_CHANNEL || !notification.payload) {
    return null;
  }
  try {
    const payload = JSON.parse(notification.payload) as Record<string, unknown>;
    const organizationId = payload.organizationId;
    const deviceId = payload.deviceId;
    const kind = payload.kind;
    const revision = payload.revision;
    if (
      typeof organizationId !== "string" ||
      organizationId.length === 0 ||
      organizationId.length > 128 ||
      typeof deviceId !== "string" ||
      deviceId.length === 0 ||
      deviceId.length > 128 ||
      (kind !== "policy" && kind !== "access_revoked") ||
      (kind === "policy" &&
        (!Number.isSafeInteger(revision) || Number(revision) <= 0))
    ) {
      return null;
    }
    return {
      deviceId,
      kind,
      organizationId,
      ...(kind === "policy" ? { revision: Number(revision) } : {}),
    };
  } catch {
    return null;
  }
}

function matches(
  notification: DesktopUpdateNotification,
  scope: DesktopUpdateScope,
): boolean {
  return (
    notification.organizationId === scope.organizationId &&
    (notification.kind === "policy" || notification.deviceId === scope.deviceId)
  );
}

export class PostgresPolicyUpdates implements DesktopPolicyUpdates {
  private client?: PoolClient;
  private detachClient?: () => void;
  private closed = false;
  private connectPromise?: Promise<void>;
  private latest: DesktopUpdateNotification[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private sequence = 0;
  private readonly waiters = new Set<PendingWaiter>();

  public constructor(private readonly pool: Pool) {}

  public async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed || this.client) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      const client = await this.pool.connect();
      if (this.closed) {
        client.release();
        return;
      }
      const onNotification = (notification: Notification) => {
        const parsed = parseNotification(notification);
        if (!parsed) return;
        const update = { ...parsed, sequence: ++this.sequence };
        this.latest = [
          update,
          ...this.latest.filter(
            (candidate) =>
              !(
                candidate.kind === update.kind &&
                candidate.organizationId === update.organizationId &&
                candidate.deviceId === update.deviceId
              ),
          ),
        ].slice(0, 2_000);
        for (const waiter of [...this.waiters]) {
          if (update.sequence > waiter.afterSequence && matches(update, waiter.scope)) {
            waiter.finish(update);
          }
        }
      };
      const onError = (error: Error) => {
        if (this.client !== client) return;
        this.client = undefined;
        this.detachClient?.();
        this.detachClient = undefined;
        client.release(error);
        this.scheduleReconnect();
      };
      client.on("notification", onNotification);
      client.on("error", onError);
      try {
        await client.query(`LISTEN ${POLICY_UPDATE_CHANNEL}`);
        if (this.closed) {
          client.removeListener("notification", onNotification);
          client.removeListener("error", onError);
          await client.query(`UNLISTEN ${POLICY_UPDATE_CHANNEL}`);
          client.release();
          return;
        }
        this.client = client;
        this.detachClient = () => {
          client.removeListener("notification", onNotification);
          client.removeListener("error", onError);
        };
        this.reconnectAttempt = 0;
      } catch (error) {
        client.removeListener("notification", onNotification);
        client.removeListener("error", onError);
        client.release(error instanceof Error ? error : true);
        throw error;
      }
    })().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      1_000 * 2 ** Math.min(this.reconnectAttempt++, 5),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  private latestForScope(
    scope: DesktopUpdateScope,
    afterSequence = -1,
  ): DesktopUpdateNotification | undefined {
    return this.latest.find(
      (notification) =>
        notification.sequence > afterSequence && matches(notification, scope),
    );
  }

  public snapshot(): number {
    return this.sequence;
  }

  public waitForChange(
    scope: DesktopUpdateScope,
    afterSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DesktopUpdateNotification | null> {
    const existing = this.latestForScope(scope, afterSequence);
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted || this.closed) return Promise.resolve(null);
    const deviceWaits = [...this.waiters].filter(
      (waiter) =>
        waiter.scope.deviceId === scope.deviceId &&
        waiter.scope.organizationId === scope.organizationId,
    ).length;
    if (
      this.waiters.size >= MAX_PENDING_WAITS ||
      deviceWaits >= MAX_PENDING_WAITS_PER_DEVICE
    ) {
      return Promise.reject(new PolicyUpdateCapacityError());
    }

    return new Promise((resolve) => {
      let settled = false;
      const waiter: PendingWaiter = {
        afterSequence,
        finish: (notification) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          this.waiters.delete(waiter);
          resolve(notification);
        },
        scope,
      };
      const onAbort = () => waiter.finish(null);
      const timeout = setTimeout(() => waiter.finish(null), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);

      if (signal?.aborted) {
        waiter.finish(null);
      } else {
        const raced = this.latestForScope(scope, afterSequence);
        if (raced) waiter.finish(raced);
      }
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const waiter of [...this.waiters]) waiter.finish(null);
    const client = this.client;
    this.client = undefined;
    this.detachClient?.();
    this.detachClient = undefined;
    if (client) {
      try {
        await client.query(`UNLISTEN ${POLICY_UPDATE_CHANNEL}`);
      } finally {
        client.release();
      }
    }
  }
}
