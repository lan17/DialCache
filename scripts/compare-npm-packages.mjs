import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);
const [beforePath, afterPath, ...extra] = process.argv.slice(2);
if (!beforePath || !afterPath || extra.length) {
  throw new Error("Usage: node scripts/compare-npm-packages.mjs before.tgz after.tgz (built at the same version)");
}

async function readPackage(path) {
  const archive = resolve(path);
  const { stdout } = await exec("tar", ["-tf", archive]);
  const paths = stdout.trim().split("\n").filter(path => !path.endsWith("/")).sort();
  if (new Set(paths).size !== paths.length || paths.some(path => !path.startsWith("package/") || path.includes(".."))) {
    throw new Error(`Unexpected package paths in ${archive}`);
  }
  return new Map(await Promise.all(paths.map(async path => {
    const { stdout: bytes } = await exec("tar", ["-xOf", archive, path], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return [path, bytes];
  })));
}

const [before, after] = await Promise.all([readPackage(beforePath), readPackage(afterPath)]);
if (!isDeepStrictEqual([...before.keys()], [...after.keys()])) {
  throw new Error(`Package paths changed: removed=${JSON.stringify([...before.keys()].filter(path => !after.has(path)))} added=${JSON.stringify([...after.keys()].filter(path => !before.has(path)))}`);
}

const changedDocsCommands = [];
let identicalFiles = 0;
for (const [path, bytes] of before) {
  const current = after.get(path);
  if (bytes.equals(current)) {
    identicalFiles++;
    continue;
  }
  if (path !== "package/package.json") throw new Error(`Published file contents changed: ${path}`);

  const previousManifest = JSON.parse(bytes.toString("utf8"));
  const currentManifest = JSON.parse(current.toString("utf8"));
  // These repository-only commands move to the workspace root. Everything
  // else, including scripts with install/build effects, must remain identical.
  for (const command of ["docs:dev", "docs:build", "docs:preview", "docs:generate", "docs:check"]) {
    const previous = previousManifest.scripts?.[command];
    const next = currentManifest.scripts?.[command];
    if (previous !== undefined && next === `pnpm -w ${command}` && previous !== next) {
      currentManifest.scripts[command] = previous;
      changedDocsCommands.push(command);
    }
  }
  if (!isDeepStrictEqual(previousManifest, currentManifest)) {
    throw new Error("Published package.json changed beyond the five workspace documentation commands");
  }
}

console.log(`Package comparison passed: ${before.size} identical paths; ${identicalFiles} byte-identical files.`);
console.log(changedDocsCommands.length
  ? `Only manifest changes: ${changedDocsCommands.join(", ")} forward to the workspace root. All other package metadata is identical.`
  : "All package metadata is identical.");
