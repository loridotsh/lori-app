import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudDevelopmentEnvironment, loadDevelopmentEnvironment, projectDevelopmentEnvironment, webDevelopmentAddress, webDevelopmentCommand } from "./dev-cloud.mjs";
import { containerWorkerPlan, developmentWorkerMode } from "./dev-cloud-worker.mjs";

test("macOS and Windows use isolated containers; text-only is explicit", () => {
  assert.equal(developmentWorkerMode({}, "darwin"), "docker");
  assert.equal(developmentWorkerMode({}, "win32"), "docker");
  assert.equal(developmentWorkerMode({}, "linux"), "native");
  assert.equal(developmentWorkerMode({ WORK_CLOUD_DEV_WORKER: "text" }, "darwin"), "text");
  assert.throws(() => developmentWorkerMode({ WORK_CLOUD_DEV_WORKER: "native" }, "darwin"), /Linux isolation/);
  assert.throws(() => developmentWorkerMode({ WORK_CLOUD_DEV_WORKER: "invalid" }), /must be/);
});

test("web restarts preserve the configured public origin and the qualified bundler", () => {
  assert.equal(webDevelopmentCommand({LORI_ADDRESS:"http://localhost:8180"}),"npm exec -w @lori-enterprise/web -- next dev --webpack --hostname localhost --port 8180");
  assert.equal(webDevelopmentCommand({LORI_ADDRESS:"http://127.0.0.1:3118"}),"npm exec -w @lori-enterprise/web -- next dev --webpack --hostname 127.0.0.1 --port 3118");
  assert.throws(()=>webDevelopmentCommand({LORI_ADDRESS:"https://company.example"}),/loopback/);
});

test("container launch preserves isolation without host mounts or leaked credentials", () => {
  const plan = containerWorkerPlan({ WORK_CLOUD_API_URL: "http://127.0.0.1:4000",
    DATABASE_PASSWORD: "private-db", OPENAI_API_KEY: "private-provider" }, "local-test", "darwin");
  assert.equal(plan.containerEnv.WORK_CLOUD_API_URL, "http://host.docker.internal:4000");
  assert.equal(plan.containerEnv.WORK_CLOUD_REQUIRE_ISOLATION, "1");
  assert.ok(plan.args.includes("--read-only"));
  assert.ok(plan.args.includes("no-new-privileges:true"));
  for (const blocked of ["--privileged", "--volume", "-v", "--network=host", "--add-host", "private-db", "private-provider"])
    assert.ok(!plan.args.includes(blocked));
  assert.equal(plan.containerEnv.OPENAI_API_KEY, undefined);
  assert.equal(plan.containerEnv.DATABASE_PASSWORD, undefined);
  assert.ok(!plan.args.includes("WORK_CLOUD_WORKER_SECRET_FILE"));
  assert.throws(() => containerWorkerPlan({ WORK_CLOUD_API_URL: "https://other.example" }, "test"), /loopback/);
  assert.throws(() => containerWorkerPlan({ WORK_CLOUD_API_URL: "http://localhost:4000", WORK_CLOUD_DEV_API_HOST: "host/path" }, "test"), /hostname/);
});

test("local Cloud Work services share a durable private credential without enabling company policy", () => {
  const directory = mkdtempSync(join(tmpdir(), "lori-dev-cloud-"));
  try {
    const first = cloudDevelopmentEnvironment({ PORT: "4019" }, directory);
    const secret = readFileSync(first.WORK_CLOUD_WORKER_SECRET_FILE, "utf8");
    const second = cloudDevelopmentEnvironment({}, directory);
    assert.equal(secret, readFileSync(second.WORK_CLOUD_WORKER_SECRET_FILE, "utf8"));
    assert.equal(statSync(first.WORK_CLOUD_WORKER_SECRET_FILE).mode & 0o777, 0o600);
    assert.equal(first.WORK_CLOUD_API_URL, "http://127.0.0.1:4019");
    assert.equal(first.LORI_API_INTERNAL_URL, first.WORK_CLOUD_API_URL);
    assert.equal(first.WORK_CLOUD_ALLOW_HTTP, "1");
    assert.ok(statSync(first.WORK_CLOUD_FILES_DIR).isDirectory());
    assert.equal(first.WORK_CLOUD_ENABLED, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("explicit opt-in refuses production, remote APIs and ambiguous credentials", () => {
  assert.throws(() => cloudDevelopmentEnvironment({ NODE_ENV: "production" }), /local development/);
  const base = { WORK_CLOUD_WORKER_SECRET: "synthetic-local-worker-secret-32-characters" };
  assert.throws(() => cloudDevelopmentEnvironment({ ...base, WORK_CLOUD_API_URL: "https://company.example" }), /loopback/);
  assert.throws(() => cloudDevelopmentEnvironment({ ...base, WORK_CLOUD_WORKER_SECRET_FILE: "/unused" }), /one worker/);
  assert.throws(() => webDevelopmentAddress({ LORI_ADDRESS: "https://company.example" }), /loopback/);
});

test("root dotenv configuration and process overrides reach every service without changing the source file", () => {
  const originalSecret = process.env.WORK_CLOUD_WORKER_SECRET;
  const directory = mkdtempSync(join(tmpdir(), "lori-dev-env-"));
  try {
    const file = join(directory, ".env");
    const text = `PORT=4017\nLORI_ADDRESS=http://127.0.0.1:3118\nWORK_CLOUD_WORKER_SECRET=synthetic-file-worker-credential-32-characters\nWORK_CLOUD_FILES_DIR=${join(directory, "configured-files")}\n`;
    writeFileSync(file, text, { mode: 0o600 });
    const overrides = { WORK_CLOUD_WORKER_SECRET: "synthetic-process-worker-credential-32-characters" };
    const loaded = loadDevelopmentEnvironment(overrides, file);
    const env = cloudDevelopmentEnvironment(loaded, directory);
    assert.equal(env.PORT, "4017");
    assert.equal(env.WORK_CLOUD_API_URL, "http://127.0.0.1:4017");
    assert.equal(env.LORI_API_INTERNAL_URL, env.WORK_CLOUD_API_URL);
    assert.equal(env.WORK_CLOUD_WORKER_SECRET, overrides.WORK_CLOUD_WORKER_SECRET);
    assert.equal(env.WORK_CLOUD_FILES_DIR, join(directory, "configured-files"));
    assert.equal(env.WORK_CLOUD_WORKER_SECRET_FILE, undefined);
    assert.equal(existsSync(join(directory, "cloud-worker-secret")), false);
    assert.deepEqual(webDevelopmentAddress(env), { hostname: "127.0.0.1", port: "3118" });
    assert.equal(readFileSync(file, "utf8"), text);
    assert.deepEqual(overrides, { WORK_CLOUD_WORKER_SECRET: "synthetic-process-worker-credential-32-characters" });
    assert.equal(process.env.WORK_CLOUD_WORKER_SECRET, originalSecret);
    const fromFile = cloudDevelopmentEnvironment({
      ...loaded,
      WORK_CLOUD_WORKER_SECRET: "",
      WORK_CLOUD_WORKER_SECRET_FILE: join(directory, "operator-worker-secret"),
    }, directory);
    assert.equal(fromFile.WORK_CLOUD_WORKER_SECRET_FILE, join(directory, "operator-worker-secret"));
    assert.equal(existsSync(join(directory, "cloud-worker-secret")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("ordinary restarts reuse established Projects keys and restricted credentials for both clients", () => {
  const directory = mkdtempSync(join(tmpdir(), "lori-dev-projects-"));
  try {
    const keyFile = join(directory, "project-content-keys.json");
    const passwordFile = join(directory, "project-runtime-password");
    const keys = JSON.stringify({ active: "existing", keys: { existing: Buffer.alloc(32, 9).toString("base64url") } });
    const password = "synthetic-runtime-password-for-tests-only";
    writeFileSync(keyFile, keys, { mode: 0o600 }); writeFileSync(passwordFile, password, { mode: 0o600 });
    const owner = { DATABASE_USER: "lori", DATABASE_PASSWORD: "synthetic-owner-password" };
    const runtime = projectDevelopmentEnvironment(owner, directory);
    assert.equal(runtime.DATABASE_USER, "lori_project_dev");
    assert.equal(runtime.DATABASE_PASSWORD, undefined);
    assert.equal(runtime.DATABASE_PASSWORD_FILE, passwordFile);
    assert.equal(runtime.WORK_CLOUD_PROJECT_KEYS_FILE, keyFile);
    assert.equal(runtime.WORK_CLOUD_PROJECTS_ENABLED, "true");
    assert.equal(runtime.WORK_CLOUD_DESKTOP_PROJECTS_ENABLED, "true");
    assert.deepEqual(projectDevelopmentEnvironment(owner, directory), runtime);
    assert.equal(readFileSync(keyFile, "utf8"), keys);
    assert.equal(readFileSync(passwordFile, "utf8"), password);
    assert.equal(owner.DATABASE_PASSWORD, "synthetic-owner-password");
    assert.deepEqual(projectDevelopmentEnvironment({ ...owner, WORK_CLOUD_PROJECTS_ENABLED: "false" }, directory), { ...owner, WORK_CLOUD_PROJECTS_ENABLED: "false" });
    const explicit = projectDevelopmentEnvironment({ ...owner, DATABASE_RUNTIME_USER: "custom_runtime", DATABASE_RUNTIME_PASSWORD_FILE: passwordFile, WORK_CLOUD_PROJECT_KEYS_FILE: keyFile, WORK_CLOUD_DESKTOP_PROJECTS_ENABLED: "false" }, directory);
    assert.equal(explicit.DATABASE_USER, "custom_runtime");
    assert.equal(explicit.WORK_CLOUD_DESKTOP_PROJECTS_ENABLED, "false");
    assert.throws(() => projectDevelopmentEnvironment({ ...owner, DATABASE_HOST: "remote.example" }, directory), /loopback/);
    assert.throws(() => projectDevelopmentEnvironment({ ...owner, DATABASE_RUNTIME_USER: "lori" }, directory), /separate restricted/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("new private-only setups stay unchanged and incomplete project setups never generate replacement keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "lori-dev-projects-missing-"));
  try {
    const base = { DATABASE_USER: "lori" };
    assert.deepEqual(projectDevelopmentEnvironment(base, directory), base);
    assert.throws(() => projectDevelopmentEnvironment({ ...base, WORK_CLOUD_PROJECTS_ENABLED: "true" }, directory), /incomplete/);
    const keyFile = join(directory, "project-content-keys.json");
    assert.equal(existsSync(keyFile), false);
    writeFileSync(keyFile, "existing key material", { mode: 0o600 });
    assert.throws(() => projectDevelopmentEnvironment(base, directory), /incomplete/);
    assert.equal(readFileSync(keyFile, "utf8"), "existing key material");
    assert.equal(existsSync(join(directory, "project-runtime-password")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
