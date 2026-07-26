# Maintainer guide

[Back to the README](../README.md)

## Validation

Use the repository's pinned pnpm version through Corepack:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test:integration
```

`pnpm check` runs strict typechecking, the unit suite with coverage,
bundles/declarations, and packed ESM/CJS consumer tests. The integration suite
uses Testcontainers and requires a working Docker-compatible container runtime
for Redis, Valkey, and Redis Cluster.

CI runs development and integration checks on Node.js 24, then switches to the
declared minimum Node.js 22.0.0 to test the packed package. Keep the consumer
floor separate from the development runtime so a new dependency or emitted
syntax cannot silently raise the published requirement.

Before changing a compatibility-sensitive surface, identify and extend the
corresponding packed, unit, and integration assertions:

- package root and explicit adapter/protocol entry points;
- full cache-key identity, encoding, namespace behavior, and Redis Cluster hash
  tags;
- deterministic partial-ramp assignment, which must not reshuffle cohorts
  across releases;
- the binary Redis frame, Lua arguments and reply domains, tracked
  read/write/invalidation semantics, and mixed-version serializer behavior; and
- bounded metrics names, labels, reasons, error categories, scopes, and units.

When changing user-facing examples, parse TypeScript fences, validate local
files and anchors, verify that README repository links are absolute for npm
rendering, and inspect the packed README. The package ships `README.md` but not
`docs/`.

## Cache-path benchmark

From a repository checkout, install dependencies and run:

```bash
corepack pnpm benchmark:request-local
```

The command builds `dist` before reporting six scenarios:

- sequential request-local hits;
- sequential process-local hits;
- enabled bounded fallbacks;
- request-local coalescing fan-out;
- process coalescing fan-out; and
- Redis read-deadline coalescing.

The benchmark is a maintainer tool and is not included in the published
package. It asserts fallback counts, coalescing state, returned values, and one
semantic read and one cleaned-up deadline timer for the remote coalescing
scenario. It deliberately applies no timing threshold.

Override its work sizes with:

- `DIALCACHE_BENCH_ITERATIONS`; and
- `DIALCACHE_BENCH_FANOUT`.

## Releasing

Publishing starts by manually running the `Release` workflow from current
`main`.

After the package checks pass, Semantic Release selects the next version from
Conventional Commits since the highest stable `vX.Y.Z` tag:

- breaking changes bump major;
- `feat` bumps minor; and
- every other normal PR-title type bumps patch.

Patch types are `fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`,
`chore`, `ci`, and `revert`. The highest required bump wins.

The workflow opens a `release: <version>` pull request whose only change is the
matching `package.json` version. `release` is a reserved Conventional Commit
type configured not to request another release, so the version-control commit
does not cause an extra bump.

GitHub marks workflow runs for a pull request opened with `GITHUB_TOKEN` as
approval-required. Approve those runs, review the pull request, and squash-merge
it normally through the protected branch.

The merge triggers the publish job. Before any release side effect, it verifies:

- current `main`;
- the release commit subject;
- the one-file diff;
- the package version;
- the absent tag; and
- Semantic Release's independently calculated version and commit.

It then reruns the package checks and asks Semantic Release to:

1. create the matching Git tag;
2. publish the public npm package with provenance; and
3. publish the GitHub release.

The repository must enable **Allow GitHub Actions to create and approve pull
requests** under Actions workflow permissions.

The workflow uses that capability only to create the version pull request. It
never approves or merges one, and no ruleset bypass actor or persistent release
credential is required.
