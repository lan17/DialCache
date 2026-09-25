# Writing shared documentation

Maintain one feature guide for the portable behavior. Keep native setup and
idioms in [TypeScript](languages/typescript.md), [Go](languages/go.md),
[Rust](languages/rust.md), and [Python](languages/python.md). The language selector changes examples, binding notes,
and API links while preserving the shared explanation and feature URL.

## Change a feature guide

1. Read the relevant contract and TypeScript reference behavior. For a new
   portable behavior, follow [formal authoring](https://github.com/lan17/DialCache/blob/main/formal/AUTHORING.md)
   and record a distinguishing regression before documenting it as supported.
2. Explain the rule, observable outcome, and limitations once. Keep concrete
   API names in small native notes where they help a reader act.
3. Implement the same teaching scenario through every port's public API. Put
   assertions around the demonstrated outcome, such as source-call counts or
   a cached value followed by a consequential invalidation.
4. Import the tested source region and link the complete file. Update the
   reviewed documentation mappings after reviewing the changed claims.

## Import tested examples

[ports.json](https://github.com/lan17/DialCache/blob/main/docs/ports.json)
registers each language's guide, reference URL, and executable example source.
Examples use matching named regions such as `request-scope`, `runtime-policy`,
and `tracked-invalidation` in every port. A shared page includes all variants:

````markdown
<LanguageContent language="typescript">

<<< @/../typescript/examples/docs.mts#request-scope{typescript}

</LanguageContent>

<LanguageContent language="go">

<<< @/../go/docs_examples_test.go#request-scope{go}

</LanguageContent>

<LanguageContent language="rust">

<<< @/../rust/tests/docs_examples.rs#request-scope{rust}

</LanguageContent>

<LanguageContent language="python">

<<< @/../python/tests/test_docs_examples.py#request-scope{python}

</LanguageContent>
````

Mark the source with `// #region request-scope` and
`// #endregion request-scope`; Python uses `# region request-scope` and
`# endregion request-scope`. Keep setup and assertions in the full executable
file, even when the displayed region omits some of that setup. State any omitted
prerequisite beside the snippet. The source check rejects missing files,
missing/duplicate regions, mismatched language sections, and a shared scenario
missing a port.

Advertised runnable examples must come from those source files. Short API
excerpts, installation commands, signatures, expected output, and protocol
frames can remain inline when their purpose is clear. Label incomplete API
fragments as excerpts; compilation of a different example does not validate them.

## Run the checks

Use the repository's pinned Node, pnpm, Go, and Rust versions and Python 3.11 or
later with the package's test dependencies. The full site build needs all four
native toolchains because references come from this
checkout. It does not need Redis or Quint exploration.

```sh
corepack pnpm docs:check  # Snippet registration and checker regression tests.
make docs               # References, catalogue, site, internal links and anchors.
corepack pnpm docs:dev   # Generate references/catalogue, then serve with hot reload.
```

Native examples execute in the existing language validation jobs. TypeScript
is compiled and run against the packed npm package, Go examples are ordinary
tests, Rust examples are integration tests, and Python examples run with pytest.
Redis tests use a dedicated
service in CI; locally point `DOCS_REDIS_URL` at a disposable Redis instance:

```sh
export DOCS_REDIS_URL=redis://127.0.0.1:6379
corepack pnpm build
corepack pnpm test:package
go -C go test -race -count=1 -run '^TestDocs' ./...
cd rust
cargo test --locked --all-features --test docs_examples -- --include-ignored
# From the repository root, with Python dependencies installed:
python/.venv/bin/python -m pytest python/tests/test_docs_examples.py
```

Without the URL, TypeScript and Go explicitly skip the Redis scenario. Rust's
Redis scenario is ignored by default and requires the explicit command above;
running that ignored test without the URL fails. Python's example is marked
`integration` and runs in `make integration-python`; without either
`DOCS_REDIS_URL` or `TEST_REDIS_URL`, a direct pytest run skips it.
The request-scope and policy
examples run without external services. The Redis scenarios use unique keys and
clean up their own data.

The docs build checks internal page links, fragments, and links into the native
references. It does not crawl external sites or every link emitted by native
reference tools. Prose-only edits need docs checks and the existing source audit;
they do not require a full Quint or mutation campaign. Behavior changes retain
the full validation requirements in the formal authoring guide.

## Generated references and evidence

TypeDoc reads TypeScript's exported entry points, `go doc -all` reads Go's public
package, rustdoc reads the Rust crate with all features, and standard-library
`pydoc` reads Python's public package and integration modules. Python uses the
interpreter in `PYTHON`, or `python/.venv/bin/python` by default. Their output and the
[behavior catalogue](generated/behavior.md) are generated on every site build,
ignored by Git, and published with the site. Edit public doc comments or the
underlying reviewed inventory to change them. The existing TypeScript API usage
notes supplement the generated signatures.

The catalogue is a navigation aid to registered models, regressions, and replay
evidence. It is not a fresh conformance report. Executing examples verifies their
assertions; reviewing the explanation and each language's actual limitations
remains necessary. Do not relabel API differences or missing behavior as parity.

## Add a port

Add its native guide and executable scenarios, register it in `docs/ports.json`,
then add its native reference command to `scripts/generate-docs.mjs` and execute
its example tests in the language's CI job. Add a matching language section for
every shared scenario; the source check identifies omissions. Keep language
specific lifecycle, ownership, codec, error and integration behavior visible in
native notes. No copy of the shared feature tree is required.
