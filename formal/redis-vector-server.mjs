import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Each mutation shard owns one real server and destroys only that container.
// No user endpoint is accepted: fixture setup must never touch user data.
export function startRedisVectorServer() {
  const name = `dialcache-formal-${randomUUID()}`;
  const docker = args => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
    if (result.error || result.status !== 0) throw new Error(`Redis vector infrastructure: docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  };
  const close = () => docker(['rm', '-f', name]);
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--publish', '127.0.0.1::6379', 'redis:6.2-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
    created = true;
    const address = docker(['port', name, '6379/tcp']);
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Unexpected private Redis port binding');
    const until = Date.now() + 20_000;
    while (true) {
      const ping = spawnSync('docker', ['exec', name, 'redis-cli', 'PING'], { encoding: 'utf8', timeout: 5000 });
      if (ping.status === 0 && ping.stdout.trim() === 'PONG') break;
      if (Date.now() >= until) throw new Error('Private Redis server did not become ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return { url: `redis://${address}`, image: docker(['inspect', '--format', '{{.Image}}', name]), close };
  } catch (error) {
    if (created) close();
    throw error;
  }
}
