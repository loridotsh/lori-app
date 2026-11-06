import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_WORKER_IMAGE = "lori-enterprise-work-worker:local";

export function developmentWorkerMode(env, platform = process.platform) {
  const mode = env.WORK_CLOUD_DEV_WORKER ?? (platform === "linux" ? "native" : "docker");
  if (!["docker", "native", "text"].includes(mode)) throw new Error("WORK_CLOUD_DEV_WORKER must be docker, native, or text");
  if (mode === "native" && platform !== "linux")
    throw new Error("Document execution requires Linux isolation. Use docker, or explicitly choose text-only mode.");
  return mode;
}

export function prepareDevelopmentWorker(env, platform = process.platform) {
  const mode = developmentWorkerMode(env, platform);
  if (mode === "text") {
    console.warn("Cloud Work is explicitly in text-only mode: PDF, Office, and command tools are unavailable.");
    return;
  }
  if (mode !== "docker") return;
  const options = { env, stdio: "ignore", timeout: 15_000 };
  if (spawnSync("docker", ["info"], options).status !== 0)
    throw new Error("Cloud Work documents require a running Docker engine. Start Docker Desktop or Colima, then retry. Text-only mode requires WORK_CLOUD_DEV_WORKER=text.");
  const image = env.WORK_CLOUD_DEV_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE;
  if (spawnSync("docker", ["image", "inspect", image], options).status !== 0)
    throw new Error("Cloud Work worker image is missing. Run npm run dev:cloud:build-worker, then retry.");
}

export function containerWorkerPlan(env, name, platform = process.platform) {
  const api = new URL(env.WORK_CLOUD_API_URL);
  if (api.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname)
    || api.username || api.password || api.pathname !== "/" || api.search || api.hash)
    throw new Error("Local worker requires a loopback HTTP API origin");
  const hostname = env.WORK_CLOUD_DEV_API_HOST ?? "host.docker.internal";
  if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) throw new Error("Invalid local container API hostname");
  api.hostname = hostname;
  const containerEnv = {
    WORK_CLOUD_API_URL: api.origin,
    WORK_CLOUD_ALLOW_HTTP: "1",
    WORK_CLOUD_REQUIRE_ISOLATION: "1",
    WORK_CLOUD_DRAIN_SECONDS: "25",
    WORK_CLOUD_WORKER_CONCURRENCY: env.WORK_CLOUD_WORKER_CONCURRENCY ?? "4",
    WORK_CLOUD_WORKER_ID: name,
  };
  return {
    containerEnv,
    args: ["run", "--rm", "--pull=never", "--name", name, "--init", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "64", "--memory", "2g", "--cpus", "1",
      // Desktop/Colima supply this DNS name themselves. Overriding it with
      // host-gateway on macOS would point at the VM instead of the host API.
      ...(platform === "linux" && !env.WORK_CLOUD_DEV_API_HOST
        ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "--tmpfs", "/var/tmp/lori-work:rw,nosuid,nodev,size=256m,mode=1777,nr_inodes=8192",
      ...[...Object.keys(containerEnv), "WORK_CLOUD_WORKER_SECRET"].flatMap((key) => ["--env", key]),
      "--entrypoint", "/usr/local/bin/lori-work-cloud-worker",
      env.WORK_CLOUD_DEV_WORKER_IMAGE ?? DEFAULT_WORKER_IMAGE],
  };
}

export function startDevelopmentWorker(env = process.env) {
  const mode = developmentWorkerMode(env);
  const name = `lori-cloud-dev-${randomUUID()}`;
  let child;
  if (mode === "docker") {
    const plan = containerWorkerPlan(env, name);
    if (env.WORK_CLOUD_WORKER_SECRET && env.WORK_CLOUD_WORKER_SECRET_FILE)
      throw new Error("Configure only one worker credential source");
    const secret = env.WORK_CLOUD_WORKER_SECRET || (env.WORK_CLOUD_WORKER_SECRET_FILE
      ? readFileSync(env.WORK_CLOUD_WORKER_SECRET_FILE, "utf8").trim() : "");
    if (secret.length < 32 || secret.length > 8192) throw new Error("Invalid local worker credential");
    // Pass only the worker credential into the container; never mount the
    // source tree, host home, Docker socket, .env, or provider credentials.
    child = spawn("docker", plan.args, { cwd: root,
      env: { ...env, ...plan.containerEnv, WORK_CLOUD_WORKER_SECRET: secret }, stdio: "inherit" });
  } else {
    child = spawn("cargo", ["run", "--locked", "--manifest-path", "apps/worker/Cargo.toml"], {
      cwd: root, env: { ...env, WORK_CLOUD_REQUIRE_ISOLATION: mode === "native" ? "1" : "0" }, stdio: "inherit",
    });
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (mode === "docker") {
      const stopper = spawn("docker", ["stop", "--time", "30", name], { env, stdio: "ignore" });
      stopper.on("error", () => child.kill("SIGTERM"));
    } else child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.once("error", () => { console.error("Unable to start the Cloud Work worker"); process.exitCode = 1; });
  child.once("exit", (code) => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.exitCode = code ?? (stopping ? 0 : 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startDevelopmentWorker();
