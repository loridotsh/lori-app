#!/usr/bin/env node
// Test-only launcher for LORI_CLOUD_EXECUTION_WORKER_BINARY. It runs the same
// sandbox image/policy as CI, with no host workspace or credential-file mounts.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const url = new URL(process.env.WORK_CLOUD_API_URL);
if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(url.hostname) || url.protocol !== 'http:')
  throw new Error('This launcher only supports a local test API.');
url.hostname = process.env.LORI_CLOUD_TEST_API_HOST ?? 'host.docker.internal';
const name = `lori-harness-test-${randomUUID()}`;
const environment = { ...process.env, WORK_CLOUD_API_URL: url.toString() };
const child = spawn('docker', [
  'run', '--rm', '--name', name, '--init', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '2g', '--cpus', '1',
  ...(process.platform === 'linux' && !process.env.LORI_CLOUD_TEST_API_HOST
    ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
  '--tmpfs', '/var/tmp/lori-work:rw,nosuid,nodev,size=256m,mode=1777,nr_inodes=8192',
  ...['WORK_CLOUD_API_URL', 'WORK_CLOUD_ALLOW_HTTP', 'WORK_CLOUD_WORKER_ID', 'WORK_CLOUD_WORKER_SECRET', 'WORK_CLOUD_DRAIN_SECONDS'].flatMap(key => ['--env', key]),
  '--entrypoint', '/usr/local/bin/lori-work-cloud-worker',
  process.env.LORI_CLOUD_TEST_WORKER_IMAGE ?? 'lori-work-harness-test',
], { env: environment, stdio: 'inherit' });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  spawn('docker', ['stop', '-t', '2', name], { stdio: 'ignore' }).on('error', () => child.kill(signal));
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? (stopping ? 0 : 1); });
