import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localDirectory = join(projectRoot, ".local");
const dataDirectory = join(localDirectory, "postgres");
const logFile = join(localDirectory, "postgres.log");
const passwordFile = join(localDirectory, ".postgres-password");
const databaseName = "lori_enterprise";
const databaseUser = "lori";
const databasePassword = "development-database-password-change-me";
const databaseHost = "127.0.0.1";
const databasePort = process.env.DATABASE_PORT ?? "55432";

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v "${command}"`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function resolvePostgresBin() {
  const configured = process.env.POSTGRES_BIN;
  const candidates = [
    configured,
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@17/bin",
  ].filter(Boolean);
  const pgCtl = commandExists("pg_ctl");

  if (pgCtl) {
    candidates.push(dirname(pgCtl));
  }

  const directory = candidates.find(
    (candidate) =>
      existsSync(join(candidate, "postgres")) &&
      existsSync(join(candidate, "pg_ctl")),
  );

  if (!directory) {
    throw new Error(
      "PostgreSQL 17 server tools were not found. On macOS, run: brew install postgresql@17",
    );
  }

  return directory;
}

const postgresBin = resolvePostgresBin();
const commandEnvironment = {
  ...process.env,
  PATH: `${postgresBin}${delimiter}${process.env.PATH ?? ""}`,
  PGPASSWORD: databasePassword,
};

function run(command, args, options = {}) {
  const result = spawnSync(join(postgresBin, command), args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: commandEnvironment,
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.status !== 0 && !options.allowFailure) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} failed${details ? `:\n${details.trim()}` : ""}`,
    );
  }

  return result;
}

function isInitialized() {
  return existsSync(join(dataDirectory, "PG_VERSION"));
}

function isRunning() {
  if (!isInitialized()) {
    return false;
  }

  return (
    run("pg_ctl", ["-D", dataDirectory, "status"], {
      allowFailure: true,
      capture: true,
    }).status === 0
  );
}

function initialize() {
  if (isInitialized()) {
    return;
  }

  mkdirSync(localDirectory, { recursive: true });
  writeFileSync(passwordFile, `${databasePassword}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(passwordFile, 0o600);

  try {
    run("initdb", [
      "-D",
      dataDirectory,
      "--username",
      databaseUser,
      "--pwfile",
      passwordFile,
      "--auth-host",
      "scram-sha-256",
      "--auth-local",
      "scram-sha-256",
      "--encoding",
      "UTF8",
      "--no-locale",
    ]);
  } finally {
    rmSync(passwordFile, { force: true });
  }
}

function start() {
  initialize();

  if (!isRunning()) {
    run("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      logFile,
      "-o",
      `-h ${databaseHost} -p ${databasePort}`,
      "-w",
      "-t",
      "30",
      "start",
    ]);
  }

  const databaseExists = run(
    "psql",
    [
      "--host",
      databaseHost,
      "--port",
      databasePort,
      "--username",
      databaseUser,
      "--dbname",
      "postgres",
      "--tuples-only",
      "--no-align",
      "--command",
      `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`,
    ],
    { capture: true },
  ).stdout.trim();

  if (databaseExists !== "1") {
    run("createdb", [
      "--host",
      databaseHost,
      "--port",
      databasePort,
      "--username",
      databaseUser,
      databaseName,
    ]);
  }

  console.log(
    `Lori development PostgreSQL is ready at ${databaseHost}:${databasePort}`,
  );
}

function stop() {
  if (!isRunning()) {
    console.log("Lori development PostgreSQL is already stopped");
    return;
  }

  run("pg_ctl", ["-D", dataDirectory, "-w", "-t", "30", "stop"]);
}

function migrate() {
  const migrationEnvironment = { ...commandEnvironment };
  delete migrationEnvironment.DATABASE_PASSWORD_FILE;
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["run", "db:migrate", "-w", "@lori-enterprise/api"],
    {
      cwd: projectRoot,
      env: {
        ...migrationEnvironment,
        DATABASE_HOST: databaseHost,
        DATABASE_NAME: databaseName,
        DATABASE_PASSWORD: databasePassword,
        DATABASE_PORT: databasePort,
        DATABASE_USER: databaseUser,
      },
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error("Database migrations failed");
  }
}

const action = process.argv[2] ?? "prepare";

if (action === "start") {
  start();
} else if (action === "stop") {
  stop();
} else if (action === "prepare") {
  start();
  migrate();
} else {
  throw new Error(`Unknown action: ${action}`);
}
