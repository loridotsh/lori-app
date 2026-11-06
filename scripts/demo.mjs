import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const actions = ["prepare", "start", "setup", "token", "rotate-token", "status", "stop"];
const images = ["lori-enterprise-api:demo", "lori-enterprise-web:demo", "lori-enterprise-work-worker:demo"];

export function demoOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    name: { type: "string", default: "lori-enterprise-demo" },
    port: { type: "string", default: "8280" },
    help: { type: "boolean", short: "h", default: false },
  } });
  const action = positionals[0] ?? "setup";
  if (!values.help && (positionals.length > 1 || !actions.includes(action)))
    throw new Error(`Choose one command: ${actions.join(", ")}.`);
  if (values.name.length > 63 || !/^lori-enterprise-demo(?:-[a-z0-9]+)*$/.test(values.name))
    throw new Error("Demo names must be lori-enterprise-demo or start with lori-enterprise-demo- followed by lowercase letters and digits.");
  if (!/^\d+$/.test(values.port) || Number(values.port) < 1024 || Number(values.port) > 65535)
    throw new Error("Choose a port between 1024 and 65535.");
  return { action, name: values.name, port: Number(values.port), help: values.help };
}

export function demoEnvironment(options, inherited = process.env) {
  // Ignore the checkout's .env and exported deployment settings. In particular,
  // a demo must never point at existing release images, projects or credentials.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(COMPOSE_|LORI_|WORK_CLOUD_|DATABASE_)/.test(key)));
  return { ...env,
    LORI_ADDRESS: `http://localhost:${options.port}`,
    LORI_HTTP_PORT: String(options.port),
    LORI_HTTPS_PORT: "8443",
    LORI_VERSION: "demo",
    LORI_ENTERPRISE_API_IMAGE: images[0],
    LORI_ENTERPRISE_WEB_IMAGE: images[1],
    LORI_ENTERPRISE_WORKER_IMAGE: images[2],
    WORK_CLOUD_PROJECTS_ENABLED: "true",
    WORK_CLOUD_DESKTOP_PROJECTS_ENABLED: "true",
  };
}

export function demoComposeArgs(options, envFile) {
  return ["compose", "--project-name", options.name, "--env-file", envFile,
    "-f", join(root, "compose.yaml"), "-f", join(root, "compose.override.yaml"),
    "-f", join(root, "compose.demo.yaml")];
}

export function demoCommand(action, options) {
  return `npm run demo -- ${action}${options.name === "lori-enterprise-demo" ? "" : ` --name ${options.name}`}${options.port === 8280 ? "" : ` --port ${options.port}`}`;
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is in use. Choose --port followed by a free port, or use the existing demo's status command.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

async function readSetup(options) {
  const response = await fetch(`http://localhost:${options.port}/api/v1/setup/status`, {
    signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!response.ok) throw new Error("The demo API is not ready. Use the status command to inspect the stack.");
  const setup = await response.json();
  if (setup.publicUrl !== `http://localhost:${options.port}` || !["ready", "requires_setup"].includes(setup.state))
    throw new Error("The service on this port does not match this demo's address.");
  return setup;
}

async function waitForReadiness(options) {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const health = await fetch(`http://localhost:${options.port}/api/health/ready`, {
        signal: AbortSignal.timeout(2000), redirect: "error",
      });
      if (health.ok && (await health.json()).status === "ok") return;
    } catch { /* Caddy may still be binding its listener after Compose returns. */ }
    await setTimeout(1000);
  }
  throw new Error(`Readiness failed. Inspect: ${demoCommand("status", options)}`);
}

export async function runDemo(args = process.argv.slice(2)) {
  const options = demoOptions(args);
  if (options.help) {
    console.log(`Local Lori Enterprise demo (Node 22+, Docker and Compose 2.24.4+).

  npm run demo -- prepare       Build current source and cache Docker images before the meeting
  npm run demo -- start         Start the prepared stack and wait for readiness
  npm run demo -- setup         Prepare and start in one command (default)
  npm run demo -- token         Print the one-time setup token in your terminal
  npm run demo -- rotate-token  Renew an expired token and reload the API
  npm run demo -- status        Show containers and whether setup is complete
  npm run demo -- stop          Stop this demo; keep its data for the next session

Optional on every command: --name lori-enterprise-demo-founder --port 8281
Defaults: project lori-enterprise-demo; http://localhost:8280.
To start a fresh organization, use a new demo name. Existing data is preserved.`);
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "lori-demo-"));
  const envFile = join(directory, "empty.env");
  writeFileSync(envFile, "", { mode: 0o600 });
  const env = demoEnvironment(options);
  const base = demoComposeArgs(options, envFile);
  function docker(args, capture = false) {
    const result = spawnSync("docker", args, { cwd: root, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
    if (result.error || result.status !== 0)
      throw new Error(`Docker command failed. Check Docker is running (Docker Desktop, or colima start), then retry. For Compose configuration errors, use Compose 2.24.4 or newer.${result.error ? ` ${result.error.message}` : ""}`);
    return result.stdout?.trim() ?? "";
  }
  const compose = (args, capture = false) => docker([...base, ...args], capture);
  try {
    docker(["info", "--format", "{{.OSType}}"], true);
    compose(["config", "--quiet"]);
    if (["prepare", "setup"].includes(options.action)) {
      console.log("Preparing current API, dashboard and isolated Work worker. The first build can take several minutes.");
      compose(["pull", "bootstrap", "database", "edge"]);
      compose(["build", "api", "web", "work-worker"]);
      console.log(`Images prepared. During the meeting run: ${demoCommand("start", options)}`);
    }
    if (["start", "setup"].includes(options.action)) {
      const edge = compose(["ps", "--status", "running", "--quiet", "edge"], true);
      if (!edge) await requireFreePort(options.port);
      for (const image of images) {
        try { docker(["image", "inspect", "--format", "{{.Id}}", image], true); }
        catch { throw new Error(`Demo images are missing. First run: ${demoCommand("prepare", options)}`); }
      }
      compose(["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180"]);
      await waitForReadiness(options);
      const setup = await readSetup(options);
      console.log(setup.state === "ready"
        ? `Demo ready: ${env.LORI_ADDRESS}/sign-in (existing organization preserved).`
        : `Demo ready: ${env.LORI_ADDRESS}/setup\nRetrieve your one-time token: ${demoCommand("token", options)}`);
    } else if (["token", "rotate-token"].includes(options.action)) {
      const setup = await readSetup(options);
      if (setup.state === "ready") throw new Error("This demo already has an administrator. Sign in, or choose a new demo name for a fresh organization.");
      if (options.action === "rotate-token") {
        // Rotation prints a secret. Keep it in the user's terminal, never a file.
        compose(["run", "--rm", "--no-deps", "setup-token-rotate"]);
        compose(["restart", "api"]);
        await waitForReadiness(options);
      } else {
        compose(["run", "--rm", "--no-deps", "setup-token"]);
      }
    } else if (options.action === "status") {
      compose(["ps", "--all"]);
      const setup = await readSetup(options);
      console.log(`Demo ${setup.state === "ready" ? "already configured" : "awaiting first administrator"}: ${env.LORI_ADDRESS}`);
    } else if (options.action === "stop") {
      compose(["down"]);
      console.log("Demo stopped. Its organization, files and secrets are preserved.");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDemo().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
