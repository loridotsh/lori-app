import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IdentityError } from "../auth/identity-service.js";
export interface LeaseClaims {
  projectId?: string;
  runId: string;
  leaseId: string;
  leaseVersion: number;
  organizationId: string;
  memberId: string;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function secureEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function signLease(secret: string, claims: LeaseClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`cloud-work-lease\0${body}`).digest("base64url")}`;
}
const LeaseSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    runId: z.string().uuid(),
    leaseId: z.string().uuid(),
    leaseVersion: z.number().int().positive(),
    organizationId: z.string().min(1).max(128),
    memberId: z.string().min(1).max(128),
  })
  .strict();
export function readLease(secret: string, authorization?: string): LeaseClaims {
  try {
    if (secret.length < 32) throw Error();
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (token.length > 2048) throw Error();
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw Error();
    const claims = LeaseSchema.parse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    );
    if (!secureEqual(signLease(secret, claims), token)) throw Error();
    return claims;
  } catch {
    throw new IdentityError(
      401,
      "cloud_worker_unauthorized",
      "Worker lease authentication failed.",
    );
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
