import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { recordAuditEvent } from "./audit.js";
import {
  normalizeEmail,
  ONBOARDING_COOKIE,
  readCookie,
  verifyOnboardingClaim,
} from "./onboarding.js";

async function invitationClaimIsActive(
  pool: Pick<Pool, "query">,
  linkId: string,
  email: string,
): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT 1
      FROM invite_links links
      JOIN invitation invitations ON invitations.id = links.invitation_id
      WHERE links.id = $1
        AND invitations.email = $2
        AND invitations.status = 'pending'
        AND links.revoked_at IS NULL
        AND links.consumed_at IS NULL
        AND links.expires_at > NOW()
      LIMIT 1
    `,
    [linkId, email],
  );
  return result.rowCount === 1;
}

/**
 * The organization whose audit log a sign-in belongs in. A session is not tied
 * to one organization, so someone in several gets none: filing it under one of
 * them would show that organization activity from a workspace it cannot see.
 */
export async function organizationIdForUser(
  pool: Pick<Pool, "query">,
  userId: string,
): Promise<string | null> {
  const result = await pool.query<{ organization_id: string }>(
    `
      SELECT members."organizationId" AS organization_id
      FROM member members
      WHERE members."userId" = $1
      LIMIT 2
    `,
    [userId],
  );
  return result.rows.length === 1 ? result.rows[0]!.organization_id : null;
}

export async function authorizeSignup(
  pool: Pick<Pool, "query">,
  config: AppConfig,
  userEmail: string,
  cookieHeader: string | null | undefined,
): Promise<string> {
  const email = normalizeEmail(userEmail);
  if (config.auth.publicSignup) {
    return email;
  }

  const cookie = readCookie(cookieHeader, ONBOARDING_COOKIE);
  const claim = verifyOnboardingClaim(cookie, config.auth.secret);

  if (!claim || claim.email !== email) {
    throw new APIError("FORBIDDEN", {
      message: "A valid Lori invitation or setup claim is required.",
    });
  }

  if (
    claim.purpose === "invitation" &&
    (!claim.invitationLinkId ||
      !(await invitationClaimIsActive(
        pool,
        claim.invitationLinkId,
        email,
      )))
  ) {
    throw new APIError("FORBIDDEN", {
      message: "This Lori invitation is no longer valid.",
    });
  }

  return email;
}

export function createAuth(pool: Pool, config: AppConfig) {
  return betterAuth({
    account: {
      accountLinking: {
        enabled: false,
      },
    },
    advanced: {
      cookiePrefix: "lori-enterprise",
      // The Fastify bridge overwrites this with request.ip after applying
      // TRUST_PROXY. Never let Better Auth trust client forwarding headers.
      ipAddress: { ipAddressHeaders: ["x-lori-client-ip"] },
      useSecureCookies: config.auth.secureCookies,
    },
    appName: "Lori Enterprise",
    basePath: "/api/auth",
    baseURL: config.publicUrl,
    database: pool,
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            const organizationId = await organizationIdForUser(
              pool,
              session.userId,
            );
            await recordAuditEvent(pool, {
              action: "session.created",
              actorUserId: session.userId,
              organizationId,
              subjectId: session.id,
              subjectType: "session",
            });
          },
        },
      },
      user: {
        create: {
          before: async (user, context) => {
            const name = user.name.trim();
            if (!name) {
              throw new APIError("BAD_REQUEST", {
                message: "Enter your name.",
              });
            }
            const email = await authorizeSignup(
              pool,
              config,
              user.email,
              context?.request?.headers.get("cookie"),
            );

            return {
              data: {
                ...user,
                email,
                name,
              },
            };
          },
        },
      },
    },
    disabledPaths: [
      "/change-email",
      "/delete-user",
      "/delete-user/callback",
      "/forget-password",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/send-verification-email",
      "/organization/create",
      "/organization/delete",
      "/organization/update",
      "/organization/check-slug",
      "/organization/get-full-organization",
      "/organization/set-active",
      "/organization/list",
      "/organization/invite-member",
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/cancel-invitation",
      "/organization/get-invitation",
      "/organization/list-invitations",
      "/organization/list-user-invitations",
      "/organization/remove-member",
      "/organization/update-member-role",
      "/organization/get-active-member",
      "/organization/get-active-member-role",
      "/organization/list-members",
      "/organization/leave",
      "/organization/has-permission",
    ],
    emailAndPassword: {
      autoSignIn: true,
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 12,
      requireEmailVerification: false,
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        cancelPendingInvitationsOnReInvite: true,
        creatorRole: "admin",
        disableOrganizationDeletion: true,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        invitationLimit: 2_500,
        membershipLimit: 2_500,
        requireEmailVerificationOnInvitation: false,
        sendInvitationEmail: async () => undefined,
      }),
    ],
    rateLimit: {
      enabled: config.environment === "production",
      max: 100,
      storage: "database",
      window: 60,
    },
    secret: config.auth.secret,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    trustedOrigins: [config.publicUrl],
    user: {
      changeEmail: {
        enabled: false,
      },
      deleteUser: {
        enabled: false,
      },
    },
  });
}

export type LoriAuth = ReturnType<typeof createAuth>;
