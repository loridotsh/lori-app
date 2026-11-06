import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ONBOARDING_COOKIE = "lori_onboarding";
export const ONBOARDING_TTL_SECONDS = 15 * 60;

export interface OnboardingClaim {
  email: string;
  expiresAt: number;
  invitationLinkId?: string;
  purpose: "setup" | "invitation";
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function safeTokenMatches(
  candidate: string,
  expected: string,
): boolean {
  const candidateHash = Buffer.from(hashToken(candidate), "hex");
  const expectedHash = Buffer.from(hashToken(expected), "hex");
  return timingSafeEqual(candidateHash, expectedHash);
}

export function signOnboardingClaim(
  claim: Omit<OnboardingClaim, "expiresAt">,
  secret: string,
  now = Date.now(),
): string {
  const payload = encode(
    JSON.stringify({
      ...claim,
      expiresAt: Math.floor(now / 1000) + ONBOARDING_TTL_SECONDS,
    }),
  );
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyOnboardingClaim(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): OnboardingClaim | null {
  if (!value) {
    return null;
  }

  const [payload, providedSignature, extra] = value.split(".");
  if (!payload || !providedSignature || extra) {
    return null;
  }

  const expectedSignature = signature(payload, secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  try {
    const claim = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as OnboardingClaim;

    if (
      (claim.purpose !== "setup" && claim.purpose !== "invitation") ||
      !claim.email ||
      !Number.isInteger(claim.expiresAt) ||
      claim.expiresAt <= Math.floor(now / 1000)
    ) {
      return null;
    }

    return {
      ...claim,
      email: normalizeEmail(claim.email),
    };
  } catch {
    return null;
  }
}

export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(valueParts.join("="));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

export function onboardingCookie(
  value: string,
  secure: boolean,
): string {
  return [
    `${ONBOARDING_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${ONBOARDING_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearOnboardingCookie(secure: boolean): string {
  return [
    `${ONBOARDING_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
