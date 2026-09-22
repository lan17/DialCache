import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ports as supportedPorts, definitions, isBurst, validateCatalogue, validateResult } from './protocol.mjs';
import { printReport, validateArtifact } from './report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../typescript/package.json', import.meta.url));

export function command(file, args, { cwd = root, input, timeout = 120_000, env = {} } = {}) {
  return new Promise((accept, reject) => {
    const child = execFile(file, args, {
      cwd, env: { ...process.env, ...env }, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${stderr.slice(-4000) || error.message}`));
      else accept(stdout.trim());
    });
    child.stdin.on('error', () => {}); // Early failure can close stdin before its request is consumed.
    child.stdin.end(input);
  });
}

export async function runWorker(worker, request, port) {
  const raw = await command(worker[0], worker.slice(1), {
    input: JSON.stringify(request), env: { GOMAXPROCS: '1' },
  });
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error(`${port}/${request.case.id}: worker did not emit one JSON result`); }
  return validateResult(result, request, port);
}

export function parseArgs(args) {
  const options = { ports: [...supportedPorts], suite: 'core', samples: 5, smoke: false };
  const flags = new Set(['ports', 'suite', 'samples', 'cases', 'kinds', 'output', 'redis-url']);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (args[i] === '--smoke') { options.smoke = true; continue; }
    if (args[i] === '--help') { options.help = true; continue; }
    assert(args[i].startsWith('--') && flags.has(name), `Unknown option ${args[i]}`);
    const value = args[++i];
    assert(value && !value.startsWith('--'), `Missing value for --${name}`);
    if (name === 'ports') options.ports = value === 'all' ? [...supportedPorts] : value.split(',');
    else if (name === 'samples') options.samples = Number(value);
    else options[name] = value;
  }
  assert(options.ports.length && new Set(options.ports).size === options.ports.length &&
    options.ports.every(p => supportedPorts.includes(p)), 'Invalid or duplicate ports');
  assert(['core', 'redis', 'all'].includes(options.suite), 'Invalid suite');
  assert(Number.isSafeInteger(options.samples) && options.samples >= 1 && options.samples <= 100, 'samples must be 1–100');
  if (options.smoke) options.samples = 1;
  return options;
}

export function selectCases(catalogue, options) {
  const all = validateCatalogue(catalogue);
  const selectedIds = options.cases?.split(',');
  const selectedKinds = options.kinds?.split(',');
  assert(!selectedIds || selectedIds.every(id => all.some(c => c.id === id)), 'Unknown case');
  assert(!selectedKinds || selectedKinds.every(k => Object.hasOwn(definitions, k)), 'Unknown kind');
  const cases = all.filter(c => (options.suite === 'all' || c.suite === options.suite) &&
    (!selectedIds || selectedIds.includes(c.id)) && (!selectedKinds || selectedKinds.includes(c.kind)))
    .map(c => options.smoke ? { ...c, iterations: Math.min(c.iterations, isBurst(c) ? 3 : 20),
      warmup: Math.min(c.warmup, 2), capacity: Math.min(c.capacity, 16), fanout: Math.min(c.fanout, 8) } : { ...c });
  assert(cases.length, 'No cases selected');
  if (selectedIds) assert(selectedIds.every(id => cases.some(c => c.id === id)), 'Selected case excluded by suite/kind');
  return cases;
}

async function buildWorkers(ports, smoke) {
  const workers = {}, builds = {};
  const bin = resolve(root, '.bench-results/bin');
  mkdirSync(bin, { recursive: true });
  for (const port of ports) {
    console.error(`Building ${port} benchmark worker…`);
    if (port === 'typescript') {
      await command('corepack', ['pnpm', 'build'], { timeout: 600_000 });
      workers[port] = [process.execPath, resolve(root, 'typescript/scripts/benchmarks/main.mjs')];
      builds[port] = { version: process.version, profile: 'built JavaScript, standard V8 JIT' };
    } else if (port === 'go') {
      const target = resolve(bin, 'dialcache-bench-go');
      await command('go', ['build', '-o', target, './cmd/dialcache-bench'], { cwd: resolve(root, 'go'), timeout: 600_000 });
      workers[port] = [target];
      builds[port] = { version: await command('go', ['version']), profile: 'go build, GOMAXPROCS=1' };
    } else {
      const output = await command('cargo', ['build', '--locked', '--profile', smoke ? 'dev' : 'release', '--bench', 'dialcache', '--features', 'redis', '--message-format=json'],
        { cwd: resolve(root, 'rust'), timeout: 900_000 });
      const artifact = output.split('\n').map(line => JSON.parse(line)).find(entry =>
        entry.reason === 'compiler-artifact' && entry.target.name === 'dialcache' && entry.target.kind.includes('bench') && entry.executable);
      assert(artifact, 'Cargo did not return the native benchmark executable');
      workers[port] = [artifact.executable];
      builds[port] = { version: await command('rustc', ['--version'], { cwd: resolve(root, 'rust') }),
        profile: `${smoke ? 'dev (execution smoke only)' : 'release'} bench, redis feature, current-thread Tokio` };
    }
  }
  return { workers, builds };
}

async function provisionRedis(url) {
  let container;
  let client;
  const stop = async () => {
    try { if (client?.isOpen) await client.disconnect(); }
    finally { if (container) await command('docker', ['rm', '-f', container]); }
  };
  try {
    let imageId = null;
    if (!url) {
      container = await command('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::6379', 'redis:6.2']);
      const address = await command('docker', ['port', container, '6379/tcp']);
      assert(/^127\.0\.0\.1:\d+$/.test(address), 'Unexpected Docker Redis binding');
      url = `redis://${address}`;
      imageId = await command('docker', ['inspect', '--format={{.Image}}', container]);
    }
    const { createClient } = require('redis');
    for (let attempt = 0; attempt < 40; attempt++) {
      client = createClient({ url, socket: { connectTimeout: 1000, reconnectStrategy: false } });
      client.on('error', () => {});
      try { await client.connect(); break; }
      catch (error) {
        if (client.isOpen) await client.disconnect();
        if (attempt === 39) throw new Error('Could not connect to dedicated benchmark Redis', { cause: error });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const info = await client.info('server');
    const field = name => new RegExp(`^${name}:(.+)$`, 'm').exec(info)?.[1].trim();
    const endpoint = new URL(url);
    const location = container ? 'local-disposable' : `${endpoint.protocol}//${endpoint.host}${endpoint.pathname || '/'}`;
    return { url, metadata: { version: field('redis_version'), mode: field('redis_mode'), imageId, location }, stop };
  } catch (error) { await stop(); throw error; }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: pnpm benchmark [--ports all|typescript,go,rust] [--suite core|redis|all]\n' +
      '  [--cases id,...] [--kinds kind,...] [--samples 5] [--smoke] [--output path]\n' +
      '  [--redis-url redis://...]  Use only a dedicated server; default starts disposable Docker Redis.');
    return;
  }
  const cases = selectCases(JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')), options);
  const output = resolve(root, options.output ?? `.bench-results/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
  assert(!existsSync(output), `Output already exists: ${output}`);
  const revision = await command('git', ['rev-parse', 'HEAD']);
  const status = await command('git', ['status', '--porcelain']);
  const diff = await command('git', ['diff', 'HEAD', '--no-ext-diff']);
  const { workers, builds } = await buildWorkers(options.ports, options.smoke);
  let redis;
  try {
    if (cases.some(c => c.suite === 'redis')) redis = await provisionRedis(options['redis-url']);
    const artifact = {
      version: 1, complete: false, createdAt: new Date().toISOString(), revision, dirty: status.length > 0,
      diffSha256: createHash('sha256').update(diff).digest('hex'), smoke: options.smoke,
      environment: { platform: platform(), arch: arch(), release: release(), hostname: hostname(),
        cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
      builds, redis: redis?.metadata ?? null, cases, ports: options.ports, samples: options.samples, results: [],
    };
    // Rotate the starting port each round. Timed workers never compete with one another.
    for (let index = 0; index < cases.length; index++) {
      const c = cases[index];
      for (let sample = 0; sample < options.samples; sample++) {
        const offset = (index + sample) % options.ports.length;
        const order = [...options.ports.slice(offset), ...options.ports.slice(0, offset)];
        for (const port of order) {
          console.error(`${c.id}: ${port}, sample ${sample + 1}/${options.samples}`);
          const id = randomUUID();
          const request = { version: 1, id, case: c, payload: 'x'.repeat(c.payloadBytes),
            redisUrl: c.suite === 'redis' ? redis.url : null };
          const result = await runWorker(workers[port], request, port);
          artifact.results.push({ id, sample, result });
        }
      }
    }
    artifact.complete = true;
    validateArtifact(artifact);
    mkdirSync(dirname(output), { recursive: true });
    const temporary = `${output}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, output);
    printReport(artifact);
    console.log(`Saved ${output}${options.smoke ? ' (smoke: validates execution, not performance)' : ''}`);
    return artifact;
  } finally { await redis?.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
