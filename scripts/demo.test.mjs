import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCommand, demoComposeArgs, demoEnvironment, demoOptions } from "./demo.mjs";

test("demo refuses arbitrary project targets and invalid commands or ports", () => {
  for (const args of [["stop", "--name", "lori-enterprise"], ["--name", "../../production"],
    ["--port", "80"], ["--port", "65536"], ["--port", "8280;whoami"], ["reset"], ["start", "stop"]])
    assert.throws(() => demoOptions(args));
  assert.equal(demoOptions([]).action, "setup");
  assert.equal(demoOptions(["--help"]).help, true);
});

test("demo cannot inherit a production address, images, Compose profile or provider settings", () => {
  const inherited = { PATH: "/bin", DOCKER_HOST: "unix:///docker.sock", LORI_ADDRESS: "https://company.example",
    LORI_ENTERPRISE_API_IMAGE: "release:old", COMPOSE_PROFILES: "tools", COMPOSE_FILE: "/production.yaml",
    DATABASE_PASSWORD: "private", WORK_CLOUD_RESEARCH_API_KEY: "private", WORK_CLOUD_PROJECTS_ENABLED: "false" };
  const options = demoOptions(["start", "--port", "8281"]);
  const env = demoEnvironment(options, inherited);
  assert.equal(env.LORI_ADDRESS, "http://localhost:8281");
  assert.equal(env.LORI_HTTP_PORT, "8281");
  assert.equal(env.LORI_ENTERPRISE_API_IMAGE, "lori-enterprise-api:demo");
  assert.equal(env.WORK_CLOUD_PROJECTS_ENABLED, "true");
  for (const key of ["COMPOSE_PROFILES", "COMPOSE_FILE", "DATABASE_PASSWORD", "WORK_CLOUD_RESEARCH_API_KEY"])
    assert.equal(env[key], undefined);
  assert.equal(env.DOCKER_HOST, inherited.DOCKER_HOST);
  assert.equal(inherited.LORI_ADDRESS, "https://company.example");
});

test("every command uses the same explicit demo files, project and empty env file", () => {
  const options = demoOptions(["token", "--name", "lori-enterprise-demo-founder", "--port", "8281"]);
  const args = demoComposeArgs(options, "/private/empty.env");
  assert.deepEqual(args.slice(0, 5), ["compose", "--project-name", "lori-enterprise-demo-founder", "--env-file", "/private/empty.env"]);
  assert.ok(args.at(-1).endsWith("compose.demo.yaml"));
  assert.equal(args.filter((arg) => arg === "-f").length, 3);
  assert.equal(demoCommand("token", options), "npm run demo -- token --name lori-enterprise-demo-founder --port 8281");
});
