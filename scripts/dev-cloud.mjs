import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { prepareDevelopmentWorker } from "./dev-cloud-worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadDevelopmentEnvironment(environment = process.env, envFile = join(root, ".env")) {
  return {
    ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}),
    ...environment,
  };
}

export function webDevelopmentAddress(environment) {
  const url = new URL(environment.LORI_ADDRESS ?? "http://localhost:3000");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("dev:cloud requires a loopback HTTP LORI_ADDRESS origin");
  }
  return { hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || "80" };
}

/** One supported web command for restarts, using the same bundler as local qualification. */
export function webDevelopmentCommand(environment) {
  const web = webDevelopmentAddress(environment);
  return `npm exec -w @lori-enterprise/web -- next dev --webpack --hostname ${web.hostname} --port ${web.port}`;
}

export function cloudDevelopmentEnvironment(environment = process.env, directory = join(root, ".local")) {
  if (environment.NODE_ENV === "production") throw new Error("dev:cloud is for local development only");
  const env = { ...environment, NODE_ENV: "development" };
  webDevelopmentAddress(env);
  env.WORK_CLOUD_API_URL ??= `http://127.0.0.1:${env.PORT ?? "4000"}`;
  const api = new URL(env.WORK_CLOUD_API_URL);
  if (api.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.username || api.password || api.pathname !== "/" || api.search || api.hash) {
    throw new Error("dev:cloud requires a loopback HTTP API origin");
  }
  if (!env.WORK_CLOUD_WORKER_SECRET && !env.WORK_CLOUD_WORKER_SECRET_FILE) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const secretFile = join(directory, "cloud-worker-secret");
    try {
      writeFileSync(secretFile, `${randomBytes(48).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    chmodSync(secretFile, 0o600);
    if (readFileSync(secretFile, "utf8").trim().length < 32) throw new Error("Invalid local worker credential");
    env.WORK_CLOUD_WORKER_SECRET_FILE = secretFile;
  }
  if (env.WORK_CLOUD_WORKER_SECRET && env.WORK_CLOUD_WORKER_SECRET_FILE) throw new Error("Configure only one worker credential source");
  if (env.WORK_CLOUD_WORKER_SECRET_FILE) env.WORK_CLOUD_WORKER_SECRET_FILE = resolve(root, env.WORK_CLOUD_WORKER_SECRET_FILE);
  env.WORK_CLOUD_FILES_DIR ??= join(directory, "cloud-files");
  env.WORK_CLOUD_FILES_DIR = resolve(root, env.WORK_CLOUD_FILES_DIR);
  mkdirSync(env.WORK_CLOUD_FILES_DIR, { recursive: true, mode: 0o700 });
  env.WORK_CLOUD_ALLOW_HTTP = "1";
  env.LORI_API_INTERNAL_URL ??= env.WORK_CLOUD_API_URL;
  return env;
}

/** Reuse an established local Projects setup; never regenerate encryption keys. */
export function projectDevelopmentEnvironment(environment, directory = join(root, ".local")) {
  const env = { ...environment };
  const savedKeys = join(directory, "project-content-keys.json");
  const savedPassword = join(directory, "project-runtime-password");
  const existingSetup = existsSync(savedKeys) || existsSync(savedPassword);
  const enabled = env.WORK_CLOUD_PROJECTS_ENABLED ?? (existingSetup ? "true" : undefined);
  if (enabled !== "true") return env;
  if (!["localhost", "127.0.0.1", "::1"].includes(env.DATABASE_HOST ?? "127.0.0.1"))
    throw new Error("Local Projects preparation requires a loopback database host.");
  const keys = resolve(root, env.WORK_CLOUD_PROJECT_KEYS_FILE || savedKeys);
  const password = resolve(root, env.DATABASE_RUNTIME_PASSWORD_FILE || savedPassword);
  if (!existsSync(keys) || !existsSync(password))
    throw new Error("Local Projects configuration is incomplete. Restore the existing project keys and runtime password, or configure WORK_CLOUD_PROJECT_KEYS_FILE and DATABASE_RUNTIME_PASSWORD_FILE. No keys were generated.");
  const role = env.DATABASE_RUNTIME_USER || "lori_project_dev";
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role) || role === (env.DATABASE_USER ?? "lori"))
    throw new Error("Local Projects require a separate restricted DATABASE_RUNTIME_USER.");
  env.WORK_CLOUD_PROJECTS_ENABLED = "true";
  env.WORK_CLOUD_DESKTOP_PROJECTS_ENABLED ??= "true";
  env.WORK_CLOUD_PROJECT_KEYS_FILE = keys;
  env.DATABASE_USER = role;
  env.DATABASE_PASSWORD_FILE = password;
  delete env.DATABASE_PASSWORD;
  delete env.DATABASE_RUNTIME_USER;
  delete env.DATABASE_RUNTIME_PASSWORD_FILE;
  return env;
}

export function startCloudDevelopment(environment = process.env) {
  const env = cloudDevelopmentEnvironment(loadDevelopmentEnvironment(environment));
  const runtime = projectDevelopmentEnvironment(env);
  prepareDevelopmentWorker(runtime);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Migrations use owner credentials; the API receives only the restricted
  // runtime credentials when Projects is configured. Never mutate .env or keys.
  for (const args of [["run", "dev:db:prepare"], ["run", "build:contracts"]]) {
    const result = spawnSync(npm, args, { cwd: root, env, stdio: "inherit" });
    if (result.status !== 0) throw new Error("Local Cloud Work preparation failed");
  }
  if (runtime.WORK_CLOUD_PROJECTS_ENABLED === "true") {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/dev-cloud-projects.mjs"], {
      cwd: root, stdio: "inherit", env: { ...env,
        WORK_CLOUD_PROJECT_KEYS_FILE: runtime.WORK_CLOUD_PROJECT_KEYS_FILE,
        DATABASE_RUNTIME_USER: runtime.DATABASE_USER,
        DATABASE_RUNTIME_PASSWORD_FILE: runtime.DATABASE_PASSWORD_FILE,
      },
    });
    if (result.status !== 0) throw new Error("Local Projects preparation failed; the server was not started with unsafe fallback credentials.");
  }
  console.log(`Local Cloud Work: ${runtime.LORI_ADDRESS ?? "http://localhost:3000"}; projects=${runtime.WORK_CLOUD_PROJECTS_ENABLED === "true"}; desktopProjects=${runtime.WORK_CLOUD_DESKTOP_PROJECTS_ENABLED === "true"}`);
  const children = [
    spawn(npm, ["exec", "--", "concurrently", "--kill-others", "-n", "api,web,worker", "-c", "blue,magenta,green",
      "npm run dev -w @lori-enterprise/api", webDevelopmentCommand(runtime),
      "node scripts/dev-cloud-worker.mjs"], { cwd: root, env: runtime, stdio: "inherit" }),
  ];
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => children.forEach((child) => child.kill(signal)));
  children[0].once("error", () => { console.error("Unable to start local Cloud Work services"); process.exitCode = 1; });
  children[0].once("exit", (code) => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startCloudDevelopment();
