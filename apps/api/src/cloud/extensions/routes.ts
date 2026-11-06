import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CloudExtensions } from "./service.js";
import { IdentityError } from "../../auth/identity-service.js";
const Root = "/v1/work/cloud/extensions";
const Params = z
  .object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) })
  .strict();
const Revision = z.number().int().positive();
export function registerExtensionRoutes(
  app: FastifyInstance,
  e: CloudExtensions,
) {
  const actor = async (req: FastifyRequest) => {
    const a = await e.cloud.actor(req.headers);
    await e.cloud.throttleRead(a.memberId);
    return a;
  };
  const mutation = async (req: FastifyRequest) => {
    if (
      !req.headers.authorization &&
      req.headers.origin !== new URL(e.cloud.config.publicUrl).origin
    )
      throw new IdentityError(
        403,
        "untrusted_origin",
        "This request came from an untrusted origin.",
      );
    const a = await e.cloud.actor(req.headers);
    await e.cloud.throttleMutation(a.memberId);
    return a;
  };
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith(Root))
      reply
        .header("cache-control", "private, no-store")
        .header("referrer-policy", "no-referrer");
  });
  app.get(Root, async (req) => e.snapshot(await actor(req)));
  app.patch(`${Root}/skills/:id`, async (req) => {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(req.body);
    return e.setSkill(
      await mutation(req),
      Params.parse(req.params).id,
      enabled,
    );
  });
  app.post(`${Root}/plugins/:id/token`, { bodyLimit: 20000 }, async (req) => {
    const body = z
      .object({ token: z.string().min(1).max(8192) })
      .strict()
      .parse(req.body);
    return e.connectToken(
      await mutation(req),
      Params.parse(req.params).id,
      body.token,
    );
  });
  app.post(`${Root}/plugins/:id/oauth`, { bodyLimit: 20000 }, async (req) => {
    const body = z
      .object({
        clientId: z.string().min(1).max(4096).optional(),
        clientSecret: z.string().min(1).max(8192).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return e.oauth.begin(
      await mutation(req),
      Params.parse(req.params).id,
      body,
    );
  });
  // OAuth codes and state arrive in the query string; disable route logging so
  // Fastify's automatic request URL logging cannot retain them.
  app.get(
    `${Root}/oauth/callback`,
    { logLevel: "silent" },
    async (req, reply) => {
      try {
        const q = z
          .object({
            state: z.string().min(1).max(200),
            code: z.string().min(1).max(4096).optional(),
            error: z.string().max(200).optional(),
            error_description: z.string().max(2000).optional(),
            error_uri: z.string().max(2000).optional(),
            scope: z.string().max(4000).optional(),
            iss: z.string().max(2000).optional(),
          })
          .strip()
          .parse(req.query);
        await e.oauth.callback(await actor(req), q);
        return reply
          .type("text/html")
          .header(
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          )
          .send(
            callbackPage(
              "Plugin connected",
              "Your connection is ready. Return to Lori to use it, or close this tab and continue where you left off.",
            ),
          );
      } catch (error) {
        const code = error instanceof IdentityError ? error.code : "";
        const title =
          code === "cloud_extension_authorization_declined"
            ? "Connection cancelled"
            : "Plugin not connected";
        const message =
          code === "cloud_extension_authorization_declined"
            ? "You did not approve this connection. You can start again from Plugins."
            : error instanceof IdentityError && error.statusCode === 401
              ? "Your Lori session ended. Sign in again, then start a new connection from Plugins."
              : "This sign-in could not be completed or has expired. Return to Plugins, refresh status, and start a new connection.";
        return reply
          .code(
            error instanceof IdentityError
              ? error.statusCode
              : error instanceof z.ZodError
                ? 400
                : 500,
          )
          .type("text/html")
          .header(
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          )
          .send(callbackPage(title, message));
      }
    },
  );
  app.post(`${Root}/plugins/:id/refresh`, async (req) => {
    const { expectedRevision } = z
      .object({ expectedRevision: Revision })
      .strict()
      .parse(req.body);
    return e.refreshConnection(
      await mutation(req),
      Params.parse(req.params).id,
      expectedRevision,
    );
  });
  app.patch(`${Root}/plugins/:id`, async (req) => {
    const body = z
      .object({ expectedRevision: Revision, enabled: z.boolean() })
      .strict()
      .parse(req.body);
    return e.setEnabled(
      await mutation(req),
      Params.parse(req.params).id,
      body.expectedRevision,
      body.enabled,
    );
  });
  app.delete(`${Root}/plugins/:id`, async (req) => {
    const body = z
      .object({ expectedRevision: Revision })
      .strict()
      .parse(req.body);
    return e.disconnect(
      await mutation(req),
      Params.parse(req.params).id,
      body.expectedRevision,
    );
  });
}

// Text is application-owned; never reflect authorization codes or provider error descriptions.
function callbackPage(title: string, message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p><a href="/work/cloud?view=plugins">Return to Plugins</a></main></body></html>`;
}
