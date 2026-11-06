import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  parseModelLimitOverrides,
  type ModelLimitOverrides,
} from "./cloud/model-limits.js";

const EnvironmentSchema = z.object({
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_SECRET_FILE: z.string().optional(),
  DATABASE_HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_NAME: z.string().min(1).default("lori_enterprise"),
  DATABASE_PASSWORD: z.string().optional(),
  DATABASE_PASSWORD_FILE: z.string().optional(),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(55432),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_USER: z.string().min(1).default("lori"),
  HOST: z.string().min(1).default("127.0.0.1"),
  LORI_ADDRESS: z.string().min(1).default("http://localhost:3000"),
  // Turns one deployment into a hosted cloud: anyone can create an individual
  // or enterprise account, and no operator setup token is involved.
  LORI_PUBLIC_SIGNUP: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PROVIDER_GATEWAY_SECRET: z.string().optional(),
  PROVIDER_GATEWAY_SECRET_FILE: z.string().optional(),
  WORK_CLOUD_FILES_DIR: z.string().min(1).optional(),
  WORK_CLOUD_PROJECTS_ENABLED: z.enum(["true", "false"]).default("false"),
  WORK_CLOUD_DESKTOP_PROJECTS_ENABLED: z.enum(["true", "false"]).default("false"),
  WORK_CLOUD_PROJECT_KEYS_FILE: z.string().min(1).optional(),
  WORK_CLOUD_WEB_RESEARCH_ENABLED: z.enum(["true", "false"]).default("true"),
  WORK_CLOUD_RESEARCH_API_KEY: z.string().trim().max(512).regex(/^[\x21-\x7e]*$/).optional(),
  // JSON map of "provider:model" to { contextTokens, outputTokens } for models
  // whose limits Cloud Work does not already know.
  WORK_CLOUD_MODEL_LIMITS: z.string().optional(),
  // How long an unanswered approval holds a run before it expires (1 to 1440).
  WORK_CLOUD_APPROVAL_TIMEOUT_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(15),
  // Retained personal projects per member, archived and recoverable-deleted included.
  WORK_CLOUD_PERSONAL_PROJECT_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100),
  // How long a deleted personal project and its chats stay recoverable (1 to 365 days).
  WORK_CLOUD_PERSONAL_PROJECT_RECOVERY_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30),
  WORK_CLOUD_WORKER_SECRET: z.string().optional(),
  WORK_CLOUD_WORKER_SECRET_FILE: z.string().optional(),
  SETUP_TOKEN: z.string().optional(),
  SETUP_TOKEN_FILE: z.string().optional(),
  SETUP_TOKEN_CREATED_AT_FILE: z
    .string()
    .min(1)
    .default("/run/lori-secrets/setup-token-created-at"),
  SERVER_VERSION: z.string().min(1).default("0.1.0"),
  // "true" trusts forwarding headers only from private-network peers (the
  // bundled edge). Any other value is a comma-separated list of proxy
  // addresses, CIDR ranges, or proxy-addr keywords. Trusting every hop would
  // let clients forge X-Forwarded-For and evade IP-keyed rate limits.
  TRUST_PROXY: z
    .string()
    .regex(/^(true|false|[0-9a-fA-F:.,/\s_a-z-]+)$/)
    .default("false"),
});

export interface AppConfig {
  auth: {
    /** Anyone may create an account; organization admins are not operators. */
    publicSignup?: boolean;
    secret: string;
    secureCookies: boolean;
    setupToken: string;
    setupTokenExpiresAt?: number;
  };
  database: {
    host: string;
    name: string;
    password: string;
    port: number;
    ssl: boolean;
    user: string;
  };
  environment: "development" | "test" | "production";
  gateway: {
    /** Encrypts upstream provider keys and signs device-scoped gateway tokens. */
    secret: string;
  };
  cloud?: {
    workerSecret: string;
    filesDirectory?: string;
    projectsEnabled?: boolean;
    desktopProjectsEnabled?: boolean;
    projectKeysFile?: string;
    modelLimits?: ModelLimitOverrides;
    approvalTimeoutMinutes?: number;
    personalProjectLimit?: number;
    personalProjectRecoveryDays?: number;
    webResearchEnabled?: boolean;
    researchApiKey?: string;
  };
  host: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  port: number;
  publicUrl: string;
  /** `false`, or the proxy addresses whose forwarding headers are trusted. */
  trustProxy: false | string;
  version: string;
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig["database"] {
  const parsed = EnvironmentSchema.parse(environment);
  return {
    host: parsed.DATABASE_HOST,
    name: parsed.DATABASE_NAME,
    password: loadSecret(
      "DATABASE_PASSWORD",
      parsed.NODE_ENV,
      parsed.DATABASE_PASSWORD,
      parsed.DATABASE_PASSWORD_FILE,
      "development-database-password-change-me",
    ),
    port: parsed.DATABASE_PORT,
    ssl: parsed.DATABASE_SSL === "require",
    user: parsed.DATABASE_USER,
  };
}

function loadSecret(
  label: string,
  environment: "development" | "test" | "production",
  value: string | undefined,
  valueFile: string | undefined,
  developmentDefault: string,
): string {
  if (value) {
    if (value.length < 32) {
      throw new Error(`${label} must be at least 32 characters`);
    }
    return value;
  }

  if (valueFile) {
    const fileValue = readFileSync(valueFile, "utf8").trim();
    if (fileValue.length < 32) {
      throw new Error(`${label}_FILE must contain at least 32 characters`);
    }
    return fileValue;
  }

  if (environment !== "production") {
    return developmentDefault;
  }

  throw new Error(`${label} or ${label}_FILE is required in production`);
}

function resolvePublicUrl(address: string): string {
  const value = address.includes("://") ? address : `https://${address}`;
  const url = new URL(value);

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "LORI_ADDRESS must be an origin without a path, query, or hash",
    );
  }

  return url.origin;
}

function loadSetupTokenExpiresAt(
  environment: "development" | "test" | "production",
  createdAtFile: string,
): number | undefined {
  if (!existsSync(createdAtFile)) {
    if (environment === "production") {
      throw new Error("SETUP_TOKEN_CREATED_AT_FILE is required in production");
    }
    return undefined;
  }
  const createdAt = Number(readFileSync(createdAtFile, "utf8").trim());
  if (!Number.isInteger(createdAt) || createdAt <= 0) {
    throw new Error(
      "SETUP_TOKEN_CREATED_AT_FILE must contain a Unix timestamp in milliseconds",
    );
  }
  return createdAt + 30 * 60 * 1_000;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const publicUrl = resolvePublicUrl(parsed.LORI_ADDRESS);
  const publicOrigin = new URL(publicUrl);

  if (
    parsed.NODE_ENV === "production" &&
    publicOrigin.protocol !== "https:" &&
    publicOrigin.hostname !== "localhost" &&
    publicOrigin.hostname !== "127.0.0.1"
  ) {
    throw new Error(
      "Production LORI_ADDRESS must use HTTPS unless it is localhost",
    );
  }
  const authSecret = loadSecret(
    "BETTER_AUTH_SECRET",
    parsed.NODE_ENV,
    parsed.BETTER_AUTH_SECRET,
    parsed.BETTER_AUTH_SECRET_FILE,
    "development-auth-secret-change-before-production",
  );
  const database = loadDatabaseConfig(environment);
  const gatewaySecret = loadSecret(
    "PROVIDER_GATEWAY_SECRET",
    parsed.NODE_ENV,
    parsed.PROVIDER_GATEWAY_SECRET,
    parsed.PROVIDER_GATEWAY_SECRET_FILE,
    "development-provider-gateway-secret-change-before-production",
  );
  const setupToken = loadSecret(
    "SETUP_TOKEN",
    parsed.NODE_ENV,
    parsed.SETUP_TOKEN,
    parsed.SETUP_TOKEN_FILE,
    "development-setup-token-change-before-production",
  );
  const setupTokenExpiresAt = loadSetupTokenExpiresAt(
    parsed.NODE_ENV,
    parsed.SETUP_TOKEN_CREATED_AT_FILE,
  );
  return {
    auth: {
      publicSignup: parsed.LORI_PUBLIC_SIGNUP === "true",
      secret: authSecret,
      secureCookies:
        parsed.NODE_ENV === "production" && publicOrigin.protocol === "https:",
      setupToken,
      setupTokenExpiresAt,
    },
    database,
    environment: parsed.NODE_ENV,
    gateway: {
      secret: gatewaySecret,
    },
    ...(parsed.WORK_CLOUD_WORKER_SECRET || parsed.WORK_CLOUD_WORKER_SECRET_FILE
      ? {
          cloud: {
            filesDirectory: parsed.WORK_CLOUD_FILES_DIR,
            projectsEnabled: parsed.WORK_CLOUD_PROJECTS_ENABLED === "true",
            desktopProjectsEnabled: parsed.WORK_CLOUD_DESKTOP_PROJECTS_ENABLED === "true",
            projectKeysFile: parsed.WORK_CLOUD_PROJECT_KEYS_FILE,
            modelLimits: parseModelLimitOverrides(
              parsed.WORK_CLOUD_MODEL_LIMITS,
            ),
            approvalTimeoutMinutes: parsed.WORK_CLOUD_APPROVAL_TIMEOUT_MINUTES,
            personalProjectLimit: parsed.WORK_CLOUD_PERSONAL_PROJECT_LIMIT,
            personalProjectRecoveryDays: parsed.WORK_CLOUD_PERSONAL_PROJECT_RECOVERY_DAYS,
            webResearchEnabled: parsed.WORK_CLOUD_WEB_RESEARCH_ENABLED === "true",
            researchApiKey: parsed.WORK_CLOUD_RESEARCH_API_KEY,
            workerSecret: loadSecret(
              "WORK_CLOUD_WORKER_SECRET",
              parsed.NODE_ENV,
              parsed.WORK_CLOUD_WORKER_SECRET,
              parsed.WORK_CLOUD_WORKER_SECRET_FILE,
              "",
            ),
          },
        }
      : {}),
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    port: parsed.PORT,
    publicUrl,
    trustProxy:
      parsed.TRUST_PROXY === "false"
        ? false
        : parsed.TRUST_PROXY === "true"
          ? "loopback,linklocal,uniquelocal"
          : parsed.TRUST_PROXY,
    version: parsed.SERVER_VERSION,
  };
}
