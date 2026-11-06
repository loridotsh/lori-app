import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { isIP } from "node:net";
import type { CloudActor } from "../service.js";
import { IdentityError } from "../../auth/identity-service.js";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const hash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
export function failure(
  code = "cloud_extension_failed",
  status = 502,
  message = "Cloud plugin request could not be completed. Review the connection and try again.",
): never {
  throw new IdentityError(status, code, message);
}
export function sessionHash(a: CloudActor) {
  const session = a.browserSessionId ?? a.sessionId;
  if (!session) failure("cloud_extension_session_required", 403);
  return hash(a.projectId ? ["project", a.projectId, a.organizationId, a.memberId, a.deviceId ?? "browser", session] : [a.organizationId, a.memberId, a.deviceId ?? "browser", session]);
}
export class CredentialVault {
  private key: Buffer;
  constructor(secret: string) {
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        "lori-cloud-work",
        "extension-credentials-v1",
        32,
      ),
    );
  }
  seal(value: unknown, aad: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }
  open<T>(value: string, aad: string): T {
    try {
      const b = Buffer.from(value, "base64url");
      const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
      );
    } catch {
      return failure("cloud_extension_credential_invalid", 409);
    }
  }
}
export function publicAddress(ip: string): boolean {
  if (ip === "168.63.129.16") return false;
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    const a = p[0]!,
      b = p[1]!;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 88)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(ip) !== 6) return false;
  // Only global unicast IPv6. Embedded IPv4, loopback, local/link-local, multicast and transition ranges excluded.
  const n = ip.toLowerCase();
  return (
    /^[23]/.test(n) &&
    !n.startsWith("2001:") &&
    !n.startsWith("2002:") &&
    !n.startsWith("3fff:")
  );
}
export function redact(value: unknown, secrets: string[]): unknown {
  const replacements = secrets
    .filter((s) => s.length >= 4)
    .flatMap((s) => [
      s,
      encodeURIComponent(s),
      Buffer.from(s).toString("base64"),
    ]);
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      for (const s of replacements)
        v = (v as string).split(s).join("[redacted]");
      return v;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [String(visit(k)), visit(x)]),
      );
    return v;
  };
  return visit(value);
}
