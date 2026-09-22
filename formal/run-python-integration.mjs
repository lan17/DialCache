#!/usr/bin/env node
/** Disposable real-server evidence; the native launcher requires every assertion. */
import { spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--suite' || !['native', 'wire'].includes(args[1]))) {
  throw new Error('Expected --suite native|wire');
}
const suite = args[1] ?? 'native';
const labelPrefix = suite === 'wire' ? 'wire' : 'python';
const python = process.env.PYTHON ?? (existsSync(join(root, 'python/.venv/bin/python'))
  ? join(root, 'python/.venv/bin/python') : 'python3');
const docker = process.env.DOCKER ?? 'docker';
const reports = join(root, '.formal-traces');
const coverage = join(root, 'coverage/python');
mkdirSync(reports, { recursive: true });
for (const label of ['Redis', 'Valkey']) {
  rmSync(join(reports, `${labelPrefix}-integration-${label}.xml`), { force: true });
  if (suite === 'native') {
    rmSync(join(coverage, `.coverage-${label}`), { force: true });
    rmSync(join(coverage, `${label}.lcov`), { force: true });
  }
}
const names = [];
let active;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  active?.kill('SIGTERM');
});

function run(command, args, { capture = false, env = process.env, allowFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    if (interrupted && command !== docker) return reject(new Error('Interrupted'));
    const child = spawn(command, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    active = child;
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (active === child) active = undefined;
      if (code === 0 || allowFailure) resolveRun({ code, stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr}`));
    });
  });
}

async function waitFor(name, port, command = ['PING'], predicate = output => output.includes('PONG')) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Interrupted');
    const result = await run(docker, ['exec', name, 'redis-cli', '-p', String(port), ...command], { capture: true, allowFailure: true });
    if (result.code === 0 && predicate(result.stdout)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${name}:${port}`);
}

async function standalone(image, kind) {
  const name = `dialcache-python-${kind}-${randomUUID().slice(0, 8)}`;
  names.push(name);
  await run(docker, ['run', '--rm', '--detach', '--name', name,
    '--label', 'dialcache.python-integration=true', '--publish', '127.0.0.1::6379', image], { capture: true });
  await waitFor(name, 6379);
  const result = await run(docker, ['port', name, '6379/tcp'], { capture: true });
  const match = result.stdout.match(/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`Missing loopback port mapping for ${name}`);
  return `redis://127.0.0.1:${match[1]}`;
}

async function freePorts() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const base = randomInt(18000, 38000);
    const sockets = [];
    try {
      for (let offset = 0; offset < 6; offset++) {
        const server = createServer();
        sockets.push(server);
        await new Promise((done, reject) => { server.once('error', reject); server.listen(base + offset, '127.0.0.1', done); });
      }
      return Array.from({ length: 6 }, (_, offset) => base + offset);
    } catch { /* Retry another bounded, nonprivileged loopback range. */ }
    finally { await Promise.all(sockets.map(server => new Promise(done => server.close(done)))); }
  }
  throw new Error('Could not allocate six loopback ports for Redis Cluster');
}

async function cluster() {
  const ports = await freePorts();
  const name = `dialcache-python-cluster-${randomUUID().slice(0, 8)}`;
  names.push(name);
  // All six nodes share a disposable container. Matching published ports keep
  // CLUSTER SLOTS addresses valid both within the container and on the host.
  const command = `for port in ${ports.join(' ')}; do redis-server --port "$port" --cluster-enabled yes --cluster-config-file "/tmp/nodes-$port.conf" --cluster-announce-ip 127.0.0.1 --cluster-announce-port "$port" --cluster-announce-bus-port "$((port + 10000))" --appendonly no --save "" --protected-mode no --daemonize yes; done; tail -f /dev/null`;
  await run(docker, ['run', '--rm', '--detach', '--name', name, '--label', 'dialcache.python-integration=true',
    ...ports.flatMap(port => ['--publish', `127.0.0.1:${port}:${port}`]), 'redis:7-alpine', 'sh', '-c', command], { capture: true });
  for (const port of ports) await waitFor(name, port);
  await run(docker, ['exec', name, 'redis-cli', '--cluster', 'create',
    ...ports.map(port => `127.0.0.1:${port}`), '--cluster-replicas', '1', '--cluster-yes'], { capture: true });
  await waitFor(name, ports[0], ['CLUSTER', 'INFO'], output => output.includes('cluster_state:ok'));
  return `redis://127.0.0.1:${ports[0]}`;
}

async function testServer(label, url, clusterUrl, isolated) {
  console.log(`${suite === 'wire' ? 'All six language pairs' : 'Python integration'}: ${label}, tracked primary reads on a six-node Redis Cluster`);
  const report = join(reports, `${labelPrefix}-integration-${label}.xml`);
  const coverageData = join(coverage, `.coverage-${label}`);
  // Instrument the process without adding a pytest plugin or weakening the
  // launcher's exact collection/outcome acceptance gate.
  const command = ['python/tests/run_integration.py', report, '--suite', suite];
  if (suite === 'native') command.unshift('-m', 'coverage', 'run', '--rcfile=python/pyproject.toml', `--data-file=${coverageData}`);
  await run(python, command, {
    env: { ...process.env, NODE: process.env.NODE ?? process.execPath,
      PYTHONPATH: [join(root, 'python'), process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      TEST_REDIS_URL: url, DOCS_REDIS_URL: url, TEST_REDIS_CLUSTER_URL: clusterUrl,
      DIALCACHE_TEST_CLUSTER_ISOLATED: isolated ? '1' : '0' },
  });
  if (suite === 'native') {
    await run(python, ['-m', 'coverage', 'lcov', '--rcfile=python/pyproject.toml',
      `--data-file=${coverageData}`, '-o', join(coverage, `${label}.lcov`)]);
  }
}

try {
  const external = [process.env.TEST_REDIS_URL, process.env.TEST_VALKEY_URL, process.env.TEST_REDIS_CLUSTER_URL];
  if (external.some(Boolean) && !external.every(Boolean)) {
    throw new Error('Supply all TEST_REDIS_URL, TEST_VALKEY_URL and TEST_REDIS_CLUSTER_URL, or none to use disposable Docker servers');
  }
  let [redisUrl, valkeyUrl, clusterUrl] = external;
  if (!redisUrl) {
    console.log('Provisioning disposable Redis 6.2, Valkey 8 and Redis 7 Cluster containers');
    redisUrl = await standalone('redis:6.2-alpine', 'redis');
    valkeyUrl = await standalone('valkey/valkey:8-alpine', 'valkey');
    clusterUrl = await cluster();
  }
  await testServer('Redis', redisUrl, clusterUrl, !external[0]);
  await testServer('Valkey', valkeyUrl, clusterUrl, !external[0]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  for (const name of names.reverse()) await run(docker, ['rm', '--force', name], { capture: true, allowFailure: true });
}
