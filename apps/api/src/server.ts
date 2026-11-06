import { buildApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { IdentityService } from "./auth/identity-service.js";
import { EnrollmentService } from "./auth/enrollment-service.js";
import { TeamService } from "./auth/team-service.js";
import { ProviderGatewayService } from "./auth/provider-gateway-service.js";
import { loadConfig } from "./config.js";
import { createPool, PostgresHealth } from "./db/database.js";
import { PostgresPolicyUpdates } from "./auth/policy-updates.js";
import { WorkService } from "./auth/work-service.js";
import { UsageAnalyticsService } from "./usage/service.js";

const config = loadConfig();
const pool = createPool(config.database);
const auth = createAuth(pool, config);
const identity = new IdentityService(pool, auth, config);
const enrollment = new EnrollmentService(pool, auth, config);
const teamService = new TeamService(pool, auth, config, enrollment);
const work = new WorkService(pool, identity, teamService, enrollment);
const providerGateway = new ProviderGatewayService(
  pool,
  auth,
  config,
  enrollment,
  work,
);
const policyUpdates = new PostgresPolicyUpdates(pool);
const usageAnalytics = new UsageAnalyticsService(
  pool,
  identity,
  enrollment,
  work,
);
await policyUpdates.start();
const app = buildApp({
  auth,
  config,
  database: new PostgresHealth(pool),
  enrollment,
  identity,
  providerGateway,
  policyUpdates,
  teamService,
  usageAnalytics,
  work,
  pool,
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await app.listen({ host: config.host, port: config.port });
  usageAnalytics.startRetentionWorker(app.log);
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
