# Generated

Everything here is written by a generator from the models and the recipes.
Never edit a file in this directory; regenerate it.

- `<profile>-smoke.itf.json` (17 files): one named history per conformance profile, the committed smoke trace every port's smoke lane replays; written by `generated-fixtures.mjs` from [../catalogs/fixture-recipes.json](../catalogs/fixture-recipes.json).
- `generated-fixtures.lock.json`: the pinned input hashes (models, recipes, generators) and output hashes of every committed fixture, including the witness fixtures under `typescript/test/fixtures/`; written in the same pass.
- `quint-key-vectors.json`, `quint-frame-vectors.json`, `quint-envelope-vectors.json`, `quint-invalidation-vectors.json`: the generated wire vectors, one per wire model, with the generator's own source hash in their provenance; written by the `generate-*-vectors.mjs` scripts.

Regenerate everything with Quint 0.32.0 on `PATH`:

```sh
node formal/tools/generate-artifacts.mjs --write
```

`make fixtures-check` (`node formal/tools/generate-artifacts.mjs --check`)
recomputes every artifact and fails on any difference; the ordinary TypeScript
suite also verifies the lock against the committed files without Quint. The
pull request lane regenerates these files only when an input they declare
changed (`.github/scripts/fixture-scope.mjs`). GitHub renders the directory as
generated.
