import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
export const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const ENROLLMENT_CODE_LIFETIME_SECONDS = 5 * 60;

type DesktopTokenPurpose = "access" | "authorization-code" | "refresh";

const TOKEN_PREFIXES: Record<DesktopTokenPurpose, string> = {
  access: "lea",
  "authorization-code": "lec",
  refresh: "ler",
};

export function generateDesktopToken(purpose: DesktopTokenPurpose): string {
  return `${TOKEN_PREFIXES[purpose]}_${randomBytes(32).toString("base64url")}`;
}

export function hashDesktopToken(
  token: string,
  secret: string,
  purpose: DesktopTokenPurpose,
): string {
  return createHmac("sha256", secret)
    .update(`lori-enterprise:${purpose}\0${token}`, "utf8")
    .digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkce(verifier: string, expectedChallenge: string): boolean {
  const actual = Buffer.from(pkceChallenge(verifier), "ascii");
  const expected = Buffer.from(expectedChallenge, "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function readBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{40,160})$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function desktopPolicyEtag(revision: number): string {
  return `"lori-policy-v1-${revision}"`;
}
