import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Reproducer = { kind: string; run: string; model?: string; failure: string; family: string; profiles: string[]; exclusions: Record<string, string>; scope?: string };
type NativeMutants = { kind: string; text: string; mutant?: string; crossContract?: string };
type Challenge = { id: string; contract: string; source: string; model: string; invariant: string; before: string; after: string; measures?: string; reproducer?: Reproducer; nativeMutants?: NativeMutants };
type Manifest = {
  check: { maxSamples: number; maxSteps: number; outputDirectory: string };
  libraries: string[];
  challenges: Challenge[];
  reproducerBacklog: string[];
  nativeMutantBacklog: string[];
  models: Array<{
    path: string;
    invariants: string[];
    regressions: string[];
    replayRegressions?: string[];
    profile?: string;
    challengeWaiver?: string;
    generate?: { maxSamples: number; maxSteps: number; traces: number; outputDirectory: string };
    vectorExport?: { generator: string; artifact: string; kind: string; cases: number; sources: string[] };
  }>;
};
type Command = { command: string; args: string[]; outputDirectory?: string; expectedTraces?: number; explicitInputs?: boolean; expectedFiles?: string[]; profile?: string };
const manifest = () => JSON.parse(readFileSync(new URL("../formal/execution.json", import.meta.url), "utf8")) as Manifest;
const moduleUrl = new URL("../formal/execution.mjs", import.meta.url).href;
const runner = fileURLToPath(new URL("../formal/run-models.mjs", import.meta.url));
type PortSection = { edits?: unknown[]; requiredDetections: string[] };
type MutantEntry = { id: string; case: string; description?: string; rationale?: string; typescript: PortSection; go: PortSection };
type Catalog = { mutations: Map<string, MutantEntry>; caseContracts: Map<string, string[]> };
type Summary = { [key: string]: unknown; nativeMutants: { mapped: number; unobservable: number; modelOnly: number; backlog: number }; unmappedMutants: number };
type Options = { readSource?(path: string): string; grandfathered?: readonly string[]; grandfatheredNative?: readonly string[]; catalog?: Catalog; files?: string[] };
const { root, scanDeclarations, scanDeclarationBodies, classifyRuns, reproducerCheckpoint, validateExecution, readMutantCatalog, checkMutantAnchors, mutantsForPort, challengesByMutant, nativeMutantKinds, grandfatheredReproducerBacklog, grandfatheredNativeMutantBacklog, quintSources } = await import(moduleUrl) as {
  root: string;
  quintSources(directory?: string): string[];
  scanDeclarations(source: string): Map<string, string>;
  scanDeclarationBodies(source: string): Map<string, { kind: string; body: string[]; spans: Array<[number, number]> }>;
  classifyRuns(declarations: Map<string, { kind: string; body: string[] }>): { publicOnly: string[]; patching: string[] };
  reproducerCheckpoint(source: string, run: string, failure: unknown): { before: string; through: string };
  validateExecution(value: unknown, options?: Options): Summary;
  readMutantCatalog(readText?: (path: string) => string): Catalog;
  checkMutantAnchors(catalog: Catalog, readText?: (path: string) => string): Map<string, string>;
  mutantsForPort(catalog: Catalog, port: "typescript" | "go"): Array<{ id: string; case: string; edits: unknown[]; requiredDetections: string[] }>;
  challengesByMutant(manifest: Manifest): Map<string, string[]>;
  nativeMutantKinds: readonly string[];
  grandfatheredReproducerBacklog: readonly string[];
  grandfatheredNativeMutantBacklog: readonly string[];
};
const { checkSemanticCoverage } = await import(new URL("../formal/check-semantic-coverage.mjs", import.meta.url).href) as {
  checkSemanticCoverage(value: unknown): unknown;
};
const { bindGeneratedTrace } = await import(new URL("../formal/run-models.mjs", import.meta.url).href) as {
  bindGeneratedTrace(profile: string, text: string, path: string): void;
};
// Exercise pure metadata checks directly: large catalogs must not depend on
// synchronous stdin pipes. The CLI dry-run check below still tests the launcher.
const validate = (value: unknown, options?: Options) => validateExecution(value, options);

describe("formal execution schedule", () => {
  it("accounts for all models, selected invariants, regressions, generated traces and challenges without Quint", () => {
    expect(validate(manifest())).toEqual({ models: 32, libraries: 23, profiles: 15, invariants: 219, regressions: 419,
      generatedTraces: 5280, exportedRegressionTraces: 252, vectorModels: 4, generatedVectors: 1631,
      challenges: 72, distinctFaults: 68, challengedModels: 32, waivedModels: 0, reproducers: 13, reproducerBacklog: 59,
      nativeMutants: { mapped: 62, unobservable: 2, modelOnly: 6, backlog: 2 }, unmappedMutants: 7 });
  });

  it("rejects omitted models and dropped or renamed regressions", () => {
    const missingModel = manifest();
    missingModel.models.shift();
    expect(() => validate(missingModel)).toThrow(/file inventory changed/);
    const hiddenModel = manifest();
    hiddenModel.libraries.push(hiddenModel.models.shift()!.path);
    expect(() => validate(hiddenModel)).toThrow(/stateful model/);
    const missingTest = manifest();
    missingTest.models[0]!.regressions.pop();
    expect(() => validate(missingTest)).toThrow(/regression schedule/);
    const renamedTest = manifest();
    renamedTest.models[0]!.regressions[0] = "renamedWithoutSuffix";
    expect(() => validate(renamedTest)).toThrow(/Test suffix/);
  });

  it("inventories the kernel library modules as libraries and keeps them pure", () => {
    const listed = manifest().libraries.filter(path => path.startsWith("formal/kernel/"));
    expect(listed.length).toBeGreaterThanOrEqual(8);
    const unlisted = manifest();
    unlisted.libraries = unlisted.libraries.filter(path => path !== "formal/kernel/serving.qnt");
    expect(() => validate(unlisted)).toThrow(/file inventory changed/);
    const nested = manifest();
    nested.libraries[nested.libraries.indexOf("formal/kernel/serving.qnt")] = "formal/kernel/deep/serving.qnt";
    expect(() => validate(nested)).toThrow(/file inventory changed/);
    const stateful = manifest();
    const kernelSource = readFileSync(new URL("../formal/kernel/clock.qnt", import.meta.url), "utf8");
    expect(() => validate(stateful, { readSource: (path: string) => path === "formal/kernel/clock.qnt" ? kernelSource.replace("type Timed[r]", "var leaked: int\n  type Timed[r]") : readFileSync(new URL(`../${path}`, import.meta.url), "utf8") }))
      .toThrow(/formal\/kernel\/clock\.qnt: a stateful model cannot be classified as a pure helper library/);
  });

  it("validates a composed profile's declared behavior version", () => {
    const layers = () => { const m = manifest(); return { m, model: m.models.find(model => model.profile === "layers")! as typeof m.models[number] & { differential?: unknown } }; };
    const versioned = layers();
    versioned.model.differential = { behaviorVersion: 1 };
    expect(() => validate(versioned.m)).not.toThrow();
    const zero = layers();
    zero.model.differential = { behaviorVersion: 0 };
    expect(() => validate(zero.m)).toThrow(/behaviorVersion must be a positive integer/);
    for (const invalid of [{ preserve: true }, {}, null, { behaviorVersion: 1, maxBytesPerStateRatio: 1.3 }]) {
      const bad = layers();
      bad.model.differential = invalid;
      expect(() => validate(bad.m), JSON.stringify(invalid)).toThrow(/unsupported differential settings/);
    }
    const unscheduled = manifest();
    (unscheduled.models.find(model => model.path === "formal/dialcache-core.qnt")! as typeof unscheduled.models[number] & { differential?: unknown }).differential = { behaviorVersion: 1 };
    expect(() => validate(unscheduled)).toThrow(/unsupported differential settings/);
  });

  it("refuses a kernel module no scheduled model imports", () => {
    const orphan = manifest();
    orphan.libraries.push("formal/kernel/orphan.qnt");
    const sources = (path: string) => path === "formal/kernel/orphan.qnt" ? "module orphan { pure def unused(n: int): int = n }" : readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    // Listed but absent from the tree: the inventory check speaks first.
    expect(() => validate(orphan, { readSource: sources })).toThrow(/file inventory changed/);
    // Listed and present, yet reached by no model: the orphan rule.
    expect(() => validate(orphan, { readSource: sources, files: [...quintSources(), "formal/kernel/orphan.qnt"] })).toThrow(/Kernel modules no scheduled model imports: formal\/kernel\/orphan\.qnt/);
  });

  it("rejects invalid exploration bounds and unsafe generation output paths", () => {
    for (const bound of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = manifest();
      invalid.check.maxSteps = bound;
      expect(() => validate(invalid)).toThrow(/positive bound/);
    }
    const tooManyTraces = manifest();
    const generation = tooManyTraces.models.find(model => model.generate)!.generate!;
    generation.traces = generation.maxSamples + 1;
    expect(() => validate(tooManyTraces)).toThrow(/trace count exceeds/);
    const unsafe = manifest();
    unsafe.models.find(model => model.generate)!.generate!.outputDirectory = ".formal-traces/features/../../formal";
    expect(() => validate(unsafe)).toThrow(/unsafe or duplicate/);
  });

  it("requires replay regressions to be scheduled tests with explicit input declarations", () => {
    const unscheduled = manifest();
    unscheduled.models.find(model => model.replayRegressions)!.replayRegressions = ["inventedTest"];
    expect(() => validate(unscheduled)).toThrow(/replay regressions need declared input and scheduled tests/);
    const duplicate = manifest();
    const model = duplicate.models.find(model => model.replayRegressions)!;
    model.replayRegressions!.push(model.replayRegressions![0]!);
    expect(() => validate(duplicate)).toThrow(/replay regressions inventory/);
    const real = manifest();
    expect(() => validateExecution(real, { readSource: path =>
      readFileSync(root + path, "utf8").replace(/\bvar input\b/g, "var hiddenInput"),
    })).toThrow(/replay regressions need declared input and scheduled tests/);
  });

  it("classifies profile runs as public-only or state-patching through fixtures, comments and strings", () => {
    const source = `module example {
      var s: int
      var input: { name: str, choice: int }
      action init = all { input' = { name: "init", choice: -1 }, s' = 0 }
      action publicStep = all { input' = { name: "publicStep", choice: -1 }, s' = s + 1 }
      action recorded(code: int): bool = all { input' = if (code == 0) { name: "a", choice: 0 } else { name: "b", choice: 1 }, s' = code }
      action patch(value: int): bool = all { input' = input, s' = value }
      action fixture = init.then(patch(5))
      def helper = s == 5
      action step = publicStep
      // run commentedTest = init.then(all { s' = 9 })
      run publicTest = init.then(publicStep).then(recorded(1)).expect(s == 1)
      run stringTest = init.then(publicStep).expect(s == 1 and "s' = 9" != "")
      run inlinePatchTest = init.then(all { input' = input, s' = 9 }).expect(s == 9)
      run fixtureTest = fixture.then(publicStep).expect(helper == false)
      run inlineStateOnlyTest = init.then(s' = 9).expect(s == 9)
    }`;
    expect(classifyRuns(scanDeclarationBodies(source))).toEqual({
      publicOnly: ["publicTest", "stringTest"],
      patching: ["inlinePatchTest", "fixtureTest", "inlineStateOnlyTest"],
    });
    const current = manifest();
    for (const model of current.models.filter(model => model.profile)) {
      const runs = classifyRuns(scanDeclarationBodies(readFileSync(root + model.path, "utf8")));
      expect([...runs.publicOnly].sort(), model.path).toEqual([...model.replayRegressions!].sort());
    }
    expect(current.models.find(model => model.profile === "effects")!.replayRegressions).toHaveLength(42);
    expect(current.models.find(model => model.profile === "shadow")!.replayRegressions).toHaveLength(7);
    expect(current.models.find(model => model.profile === "independent")!.replayRegressions).toHaveLength(7);
  });

  it("forces every public-only run to be exported and keeps state-patching runs out of replay", () => {
    const unexported = manifest();
    const core = unexported.models.find(model => model.profile === "core")!;
    const dropped = core.replayRegressions!.pop()!;
    expect(() => validate(unexported)).toThrow(new RegExp(`public-only runs are not exported as replay regressions: ${dropped}`));
    const patched = manifest();
    const effects = patched.models.find(model => model.profile === "effects")!;
    effects.replayRegressions!.push("followerKeepsAcceptedReadBudgetTest");
    expect(() => validate(patched)).toThrow(/state-patching runs cannot be replay regressions: followerKeepsAcceptedReadBudgetTest/);
  });

  it("rejects a generated history whose choice leaves the driver domain at generation time", () => {
    const smoke = readFileSync(root + "formal/local-failure-smoke.itf.json", "utf8");
    expect(() => bindGeneratedTrace("local-failure", smoke, "smoke")).not.toThrow();
    const trace = JSON.parse(smoke) as { states: Array<Record<string, any>> };
    const step = trace.states.find(state => state.input.name === "beginCall")!;
    step.input.choice["#bigint"] = "7";
    step["mbt::nondetPicks"].choice.value["#bigint"] = "7";
    expect(() => bindGeneratedTrace("local-failure", JSON.stringify(trace), "regression")).toThrow(/regression step \d+: unsupported explicit choice/);
    const renamed = JSON.parse(smoke) as { states: Array<Record<string, any>> };
    renamed.states.find(state => state.input.name === "beginCall")!.input.name = "inventedAction";
    expect(() => bindGeneratedTrace("local-failure", JSON.stringify(renamed), "regression")).toThrow(/unknown or misplaced action|conflicting action metadata/);
  });

  it("validates every challenge against contracts, scheduled invariants and unique anchors", () => {
    const unknownContract = manifest();
    unknownContract.challenges[0]!.contract = "C99";
    expect(() => validate(unknownContract)).toThrow(/unknown contract C99/);
    const duplicateId = manifest();
    duplicateId.challenges[1]!.id = duplicateId.challenges[0]!.id;
    expect(() => validate(duplicateId)).toThrow(/Invalid or duplicate challenge id/);
    const missingAnchor = manifest();
    missingAnchor.challenges[0]!.before = "this text is not in the model";
    expect(() => validate(missingAnchor)).toThrow(/mutation anchor must match exactly once/);
    const ambiguousAnchor = manifest();
    const rules = ambiguousAnchor.challenges.find(challenge => challenge.source === "formal/cache-rules.qnt")!;
    rules.before = "pure def";
    expect(() => validate(ambiguousAnchor)).toThrow(/mutation anchor must match exactly once/);
    const unscheduledInvariant = manifest();
    unscheduledInvariant.challenges[0]!.invariant = "unscheduledInvariant";
    expect(() => validate(unscheduledInvariant)).toThrow(/is not a scheduled invariant/);
    const foreignSource = manifest();
    foreignSource.challenges[0]!.source = "src/index.ts";
    expect(() => validate(foreignSource)).toThrow(/not a scheduled model or library/);
    const libraryModel = manifest();
    libraryModel.challenges[0]!.model = "formal/cache-rules.qnt";
    expect(() => validate(libraryModel)).toThrow(/challenged model is not scheduled/);
    const noop = manifest();
    noop.challenges[0]!.after = noop.challenges[0]!.before;
    expect(() => validate(noop)).toThrow(/mutation must change the source/);
    const repeated = manifest();
    const { measures: _ignored, ...first } = repeated.challenges[0]!;
    repeated.challenges.push({ ...first, id: "repeated-fault" });
    repeated.reproducerBacklog.push("repeated-fault");
    // A test-only grandfather list: production keeps the frozen constant.
    const grandfathered = [...grandfatheredReproducerBacklog, "repeated-fault"];
    expect(() => validate(repeated, { grandfathered })).toThrow(/repeated-fault: repeats the fault of .* without a measures note/);
    repeated.challenges.at(-1)!.measures = "Measures the same fault against a second invariant.";
    expect(validate(repeated, { grandfathered }).distinctFaults).toBe(validate(manifest()).distinctFaults);
    const strayNote = manifest();
    strayNote.challenges.find(challenge => !challenge.measures)!.measures = "not a repeat";
    expect(() => validate(strayNote)).toThrow(/a measures note is only for a repeated fault/);
  });

  it("requires a challenge for every scheduled model unless the model carries an explicit waiver", () => {
    const uncovered = manifest();
    const target = uncovered.models.find(model => model.path === "formal/dialcache-core.qnt")!;
    uncovered.challenges = uncovered.challenges.filter(challenge => challenge.model !== target.path);
    uncovered.reproducerBacklog = uncovered.reproducerBacklog.filter(id => uncovered.challenges.some(challenge => challenge.id === id));
    uncovered.nativeMutantBacklog = uncovered.nativeMutantBacklog.filter(id => uncovered.challenges.some(challenge => challenge.id === id));
    expect(() => validate(uncovered)).toThrow(/dialcache-core\.qnt: scheduled invariants have no model property challenge and no challengeWaiver/);
    target.challengeWaiver = "   ";
    expect(() => validate(uncovered)).toThrow(/challenge waiver must explain an unchallenged model/);
    target.challengeWaiver = "No compiling single-site fault is detectable by the scheduled invariants.";
    expect(validate(uncovered)).toMatchObject({ challengedModels: 31, waivedModels: 1 });
    const redundantWaiver = manifest();
    redundantWaiver.models[0]!.challengeWaiver = "Already challenged.";
    expect(() => validate(redundantWaiver)).toThrow(/challenge waiver must explain an unchallenged model/);
    const legacy = manifest();
    (legacy.models[2] as Record<string, unknown>).propertyChallenge = "formal/check-model-properties.mjs";
    expect(() => validate(legacy)).toThrow(/property challenges live in the manifest challenges catalog/);
  });

  it("requires every challenge to carry a reproducer or sit in the reported backlog, and nothing else", () => {
    const current = manifest();
    const withReproducer = current.challenges.filter(challenge => challenge.reproducer);
    expect(withReproducer.map(challenge => challenge.id)).toEqual([
      "policy-inclusive-local-expiry", "policy-inclusive-remote-freshness", "shadow-inclusive-c0-freshness", "scope-nested-close-evicts-outer-memo", "admission-capacity-off-by-one", "local-clock-precise-ttl", "stale-recovery-future-candidate", "envelope-strips-unknown-zero-prefix", "source-budgets-accepts-at-deadline-equality", "policy-hit-before-join", "policy-join-ignores-coalesce", "source-budgets-settlement-never-replaces-local-entry", "source-budgets-failed-settlement-clears-local-entry",
    ]);
    expect(withReproducer.map(challenge => challenge.reproducer!.kind)).toEqual([
      "exported-regression", "exported-regression", "exported-regression", "exported-regression", "exported-regression", "exported-regression", "exported-regression", "model-run", "exported-regression", "exported-regression", "exported-regression", "exported-regression", "exported-regression",
    ]);
    // The shared-rule fault of a verification model is pinned by a profile's exported regression.
    expect(withReproducer.find(challenge => challenge.id === "stale-recovery-future-candidate")!.reproducer).toMatchObject({
      model: "formal/dialcache-policy-conformance.qnt", run: "wallRollbackRejectsFutureRemoteFrameTest", profiles: ["formal/dialcache-stale-recovery.qnt", "recovery", "policy", "shadow"],
    });
    expect([...current.reproducerBacklog].sort()).toEqual(current.challenges.filter(challenge => !challenge.reproducer).map(challenge => challenge.id).sort());
    const unlisted = manifest();
    const dropped = unlisted.reproducerBacklog.shift()!;
    expect(() => validate(unlisted)).toThrow(new RegExp(`${dropped}: has no reproducer and is not listed in reproducerBacklog`));
    const both = manifest();
    both.reproducerBacklog.push("policy-inclusive-local-expiry");
    expect(() => validate(both)).toThrow(/policy-inclusive-local-expiry: has a reproducer and is listed in reproducerBacklog/);
    const unknown = manifest();
    unknown.reproducerBacklog.push("invented-fault");
    expect(() => validate(unknown)).toThrow(/reproducerBacklog names an unknown challenge: invented-fault/);
    // A new challenge cannot opt out by listing itself: only the frozen
    // grandfather list may appear in the backlog, and it only shrinks.
    const optedOut = manifest();
    const { measures: _note, reproducer: _reproducer, ...template } = optedOut.challenges.find(challenge => challenge.reproducer)!;
    optedOut.challenges.push({ ...template, id: "new-fault-without-reproducer", after: template.after + " and true" });
    optedOut.reproducerBacklog.push("new-fault-without-reproducer");
    expect(() => validate(optedOut)).toThrow(/new-fault-without-reproducer: new challenges must carry a reproducer/);
    expect([...grandfatheredReproducerBacklog].sort()).toEqual([...manifest().reproducerBacklog].sort());
    const duplicate = manifest();
    duplicate.reproducerBacklog.push(duplicate.reproducerBacklog[0]!);
    expect(() => validate(duplicate)).toThrow(/Duplicate challenge ids in reproducerBacklog/);
    const missing = manifest();
    delete (missing as Partial<Manifest>).reproducerBacklog;
    expect(() => validate(missing)).toThrow(/reproducer backlog is missing/);
  });

  it("maps every challenge to a native mutant in the catalog or an enumerated explanation, and freezes the backlog", () => {
    // A small catalog fixture: M01 and M11 require generated detection in both
    // ports, M40 sits on a C40 case and M20 requires generated detection only in
    // TypeScript.
    const entry = (id: string, kase: string, typescript: string[], go = typescript): MutantEntry => ({ id, case: kase, typescript: { requiredDetections: typescript }, go: { requiredDetections: go } });
    const catalog = (): Catalog => ({
      mutations: new Map([
        ["M01", entry("M01", "C45.maximum-age-exclusive", ["ordinary", "generated", "portable"], ["generated", "portable"])],
        ["M11", entry("M11", "C09.fixed-local-ttl", ["generated", "portable"])],
        ["M20", entry("M20", "C11.distinct-keys", ["generated", "portable"], [])],
        ["M40", entry("M40", "C40.future-rejected", ["generated", "portable"])],
      ]),
      caseContracts: new Map([["C45.maximum-age-exclusive", ["C45"]], ["C09.fixed-local-ttl", ["C09"]], ["C11.distinct-keys", ["C11"]], ["C40.future-rejected", ["C40"]]]),
    });
    // The rules are exercised against the fixture catalog, not the live mapping:
    // start from the live manifest with every challenge explained and the frozen
    // backlog, then vary one challenge at a time.
    const explained = () => {
      const m = manifest();
      m.nativeMutantBacklog = [...grandfatheredNativeMutantBacklog];
      for (const challenge of m.challenges) {
        if (m.nativeMutantBacklog.includes(challenge.id)) delete challenge.nativeMutants;
        else challenge.nativeMutants = { kind: "model-only", text: "Fixture: no line in src/dialcache.ts carries this bookkeeping." };
      }
      return m;
    };
    const withNative = (id: string, native: NativeMutants | undefined, edit: (m: Manifest) => void = () => undefined) => {
      const m = explained();
      const challenge = m.challenges.find(challenge => challenge.id === id)!;
      if (native === undefined) delete challenge.nativeMutants; else challenge.nativeMutants = native;
      edit(m);
      return () => validate(m, { catalog: catalog() });
    };
    const mapped = (mutant: string, crossContract?: string): NativeMutants => ({ kind: "mapped", text: `Fixture mapping of ${mutant}.`, mutant, ...(crossContract === undefined ? {} : { crossContract }) });
    expect(nativeMutantKinds).toEqual(["mapped", "unobservable", "model-only"]);
    expect(grandfatheredNativeMutantBacklog).toEqual(["invalidation-transition-cutoff-moves-backwards", "invalidation-transition-inclusive-buffer-limit"]);
    // The mutant sits in the catalog.
    expect(withNative("policy-inclusive-local-expiry", mapped("M99"))).toThrow(/policy-inclusive-local-expiry: M99 is not in the mutant catalog/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "mapped", text: "x" })).toThrow(/policy-inclusive-local-expiry: mapped nativeMutants need a mutant id/);
    // The mutant's case lists the challenge's contract, or exactly one crossContract sentence says why not.
    expect(withNative("policy-inclusive-local-expiry", mapped("M11"))().nativeMutants).toMatchObject({ mapped: 1 });
    expect(withNative("policy-inclusive-local-expiry", mapped("M01"))).toThrow(/policy-inclusive-local-expiry: M01 is on case C45.maximum-age-exclusive which does not list C09; add a crossContract reason/);
    expect(withNative("policy-inclusive-local-expiry", mapped("M01", "  "))).toThrow(/M01 is on case C45.maximum-age-exclusive which does not list C09/);
    expect(withNative("policy-inclusive-local-expiry", mapped("M01", "The shared rule reaches the local layer too."))().nativeMutants).toMatchObject({ mapped: 1 });
    expect(withNative("policy-inclusive-local-expiry", mapped("M11", "not needed"))).toThrow(/policy-inclusive-local-expiry: crossContract note for in-contract mutant M11/);
    // Kinds, text, and which kinds name a mutant. The text carries the why and stays short; the where lives on the catalog entry.
    expect(withNative("policy-inclusive-local-expiry", { kind: "native", text: "x", mutant: "M11" })).toThrow(/nativeMutants kind must be one of mapped, unobservable, model-only/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "mapped", text: "  ", mutant: "M11" })).toThrow(/nativeMutants text must say why the mutant is the same fault or explain why none exists/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "mapped", text: "Names no mutant.", mutant: "M11" })).toThrow(/policy-inclusive-local-expiry: nativeMutants text must name M11/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "mapped", text: `M11 ${"x".repeat(500)}`, mutant: "M11" })).toThrow(/policy-inclusive-local-expiry: nativeMutants text exceeds 500 characters; the port-side account belongs in the mutant's rationale/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "model-only", text: `src/dialcache.ts ${"x".repeat(900)}` })).toThrow(/nativeMutants text exceeds 900 characters/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "model-only", text: "x", mutant: "M11" })).toThrow(/model-only nativeMutants name no mutant/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "unobservable", text: "x", crossContract: "y" })).toThrow(/unobservable nativeMutants name no mutant/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "model-only", text: "No file named." })).toThrow(/model-only nativeMutants text must name the port file it examined/);
    expect(withNative("policy-inclusive-local-expiry", { kind: "unobservable", text: "The read in src/context.ts checks closure again." })().nativeMutants).toMatchObject({ unobservable: 1 });
    expect(withNative("policy-inclusive-local-expiry", { ...mapped("M11"), note: "extra" } as NativeMutants)).toThrow(/policy-inclusive-local-expiry: unsupported nativeMutants field note/);
    expect(withNative("policy-inclusive-local-expiry", [] as unknown as NativeMutants)).toThrow(/policy-inclusive-local-expiry: invalid nativeMutants/);
    // A mapped mutant requires generated detection in both ports.
    expect(withNative("layers-late-memo-into-closed-scope", mapped("M20"))).toThrow(/layers-late-memo-into-closed-scope: M20 must require generated detection in both ports/);
    // A repeated fault maps the same way; the texts may differ.
    const twins = ["scope-late-source-repopulates-closed-memo", "layers-late-memo-into-closed-scope"];
    const unobservable = (text: string): NativeMutants => ({ kind: "unobservable", text: `${text} The read in src/context.ts checks closure again.` });
    const agreeing = withNative(twins[0]!, unobservable("Scope wording."), m => { m.challenges.find(challenge => challenge.id === twins[1])!.nativeMutants = unobservable("Layers wording."); });
    expect(agreeing().nativeMutants).toMatchObject({ unobservable: 2 });
    expect(withNative(twins[0]!, unobservable("x"))).toThrow(/layers-late-memo-into-closed-scope: maps the fault of scope-late-source-repopulates-closed-memo differently/);
    const crossOnly = withNative("recovery-inclusive-maximum", mapped("M40", "Recovery reaches the shared rule."), m => {
      m.challenges.find(challenge => challenge.id === "legacy-recovery-inclusive-maximum")!.nativeMutants = mapped("M40", "The legacy path reaches it too.");
    });
    expect(crossOnly().nativeMutants).toMatchObject({ mapped: 2 });
    // The backlog is the exact set of challenges without an entry, and only the grandfathered ones may sit in it.
    expect(withNative("policy-inclusive-local-expiry", undefined)).toThrow(/policy-inclusive-local-expiry: has no nativeMutants and is not listed in nativeMutantBacklog/);
    expect(withNative("policy-inclusive-local-expiry", undefined, m => { m.nativeMutantBacklog.push("policy-inclusive-local-expiry"); }))
      .toThrow(/policy-inclusive-local-expiry: new challenges must map to a native mutant in both ports or explain why none exists; nativeMutantBacklog only grandfathers the challenges that predate the requirement/);
    // A test-only grandfather list admits it: production keeps the frozen constant.
    const optedIn = explained();
    delete optedIn.challenges.find(challenge => challenge.id === "policy-inclusive-local-expiry")!.nativeMutants;
    optedIn.nativeMutantBacklog.push("policy-inclusive-local-expiry");
    expect(validate(optedIn, { catalog: catalog(), grandfatheredNative: [...grandfatheredNativeMutantBacklog, "policy-inclusive-local-expiry"] }).nativeMutants).toMatchObject({ backlog: 3 });
    expect(withNative("policy-inclusive-local-expiry", mapped("M11"), m => { m.nativeMutantBacklog.push("policy-inclusive-local-expiry"); })).toThrow(/policy-inclusive-local-expiry: has nativeMutants and is listed in nativeMutantBacklog/);
    expect(withNative("policy-inclusive-local-expiry", mapped("M11"), m => { m.nativeMutantBacklog.push("invented-fault"); })).toThrow(/nativeMutantBacklog names an unknown challenge: invented-fault/);
    expect(withNative("policy-inclusive-local-expiry", mapped("M11"), m => { m.nativeMutantBacklog.push(m.nativeMutantBacklog[0]!); })).toThrow(/Duplicate challenge ids in nativeMutantBacklog/);
    expect(withNative("policy-inclusive-local-expiry", mapped("M11"), m => { delete (m as Partial<Manifest>).nativeMutantBacklog; })).toThrow(/Challenge native-mutant backlog is missing/);
    expect(withNative("invalidation-transition-cutoff-moves-backwards", { kind: "model-only", text: "Only src/internal/redis-scripts.ts carries it." })).toThrow(/invalidation-transition-cutoff-moves-backwards: has nativeMutants and is listed in nativeMutantBacklog/);
    // The summary counts every kind, the backlog and the catalog mutants no challenge cites.
    const summary = withNative("policy-inclusive-local-expiry", mapped("M11"), m => {
      m.challenges.find(challenge => challenge.id === twins[0])!.nativeMutants = unobservable("Scope.");
      m.challenges.find(challenge => challenge.id === twins[1])!.nativeMutants = unobservable("Layers.");
    })();
    expect(summary.nativeMutants).toEqual({ mapped: 1, unobservable: 2, modelOnly: 67, backlog: 2 });
    expect(summary.unmappedMutants).toBe(3);
    const fixture = explained();
    expect(challengesByMutant({ ...fixture, challenges: [{ ...fixture.challenges[0]!, nativeMutants: mapped("M11") }, { ...fixture.challenges[1]!, nativeMutants: mapped("M11") }, { ...fixture.challenges[2]!, nativeMutants: mapped("M01") }, fixture.challenges[3]!] }))
      .toEqual(new Map([["M11", [fixture.challenges[0]!.id, fixture.challenges[1]!.id]], ["M01", [fixture.challenges[2]!.id]]]));
  });

  it("maps every live challenge outside the frozen native-mutant backlog, and cites only catalog mutants", () => {
    const live = manifest();
    expect([...live.nativeMutantBacklog].sort()).toEqual([...grandfatheredNativeMutantBacklog].sort());
    expect(live.challenges.filter(challenge => challenge.nativeMutants === undefined).map(challenge => challenge.id).sort()).toEqual([...grandfatheredNativeMutantBacklog].sort());
    const catalog = readMutantCatalog();
    const cited = challengesByMutant(live);
    for (const [mutant, ids] of cited) {
      expect(catalog.mutations.has(mutant), mutant).toBe(true);
      for (const id of ids) expect(live.challenges.find(challenge => challenge.id === id)!.nativeMutants!.mutant, mutant).toBe(mutant);
    }
    // The catalog mutants no challenge cites are reported, not gated: the summary counts them and nothing pins which they are.
    expect(validate(live).unmappedMutants).toBe([...catalog.mutations.keys()].filter(id => !cited.has(id)).length);
  });

  it("validates the unified mutant catalog and anchors every edit in the port text", () => {
    const live = readMutantCatalog();
    expect(live.mutations.size).toBeGreaterThanOrEqual(13);
    for (const port of ["typescript", "go"] as const) {
      for (const mutation of mutantsForPort(live, port)) expect(Array.isArray(mutation.edits) && mutation.edits.length > 0 && Array.isArray(mutation.requiredDetections), `${port} ${mutation.id}`).toBe(true);
    }
    expect(live.caseContracts.get("C45.maximum-age-exclusive")).toEqual(["C45"]);
    // Every live anchor matches its port text exactly once; the originals cover every edited file.
    const anchored = checkMutantAnchors(live);
    for (const mutation of live.mutations.values()) for (const port of ["typescript", "go"] as const) for (const edit of mutation[port].edits as Array<{ path: string }>) expect(anchored.has(edit.path), `${mutation.id} ${edit.path}`).toBe(true);
    const cases = JSON.stringify({ cases: [{ id: "C45.maximum-age-exclusive", contracts: ["C45"] }, { id: "C25.late-source-rejected", contracts: ["C25"] }] });
    type Edit = { path: string; before: string; after: string };
    type Section = { edits?: Edit[]; requiredDetections?: string[] };
    const entry = (id: string, overrides: { case?: string; description?: string; rationale?: string; typescript?: Section | null; go?: Section | null; extra?: Record<string, unknown> } = {}) => ({
      id, case: overrides.case ?? "C45.maximum-age-exclusive", description: overrides.description ?? "d", rationale: overrides.rationale ?? "Edits src/a.ts and go/a.go.",
      ...(overrides.typescript === null ? {} : { typescript: { edits: [{ path: "src/a.ts", before: "alpha", after: "beta" }], requiredDetections: ["generated", "portable"], ...overrides.typescript } }),
      ...(overrides.go === null ? {} : { go: { edits: [{ path: "go/a.go", before: "alpha", after: "beta" }], requiredDetections: ["generated", "portable"], ...overrides.go } }),
      ...overrides.extra,
    });
    const catalogText = (mutations: unknown[], schemaVersion = 1) => JSON.stringify({ schemaVersion, mutations });
    const files: Record<string, string> = { "src/a.ts": "export const alpha = 1;\n", "go/a.go": "package dialcache\n\nvar alpha = 1\n", "src/twice.ts": "alpha alpha\n" };
    const read = (text: string) => (path: string) => {
      const found = ({ "formal/mutations.json": text, "formal/semantic-cases.json": cases, ...files })[path];
      if (found === undefined) throw new Error(`no such file ${path}`);
      return found;
    };
    const parsed = readMutantCatalog(read(catalogText([entry("M01"), entry("M02", { case: "C25.late-source-rejected" })])));
    expect([...parsed.mutations.keys()]).toEqual(["M01", "M02"]);
    expect(parsed.caseContracts.get("C25.late-source-rejected")).toEqual(["C25"]);
    expect(mutantsForPort(parsed, "go").map(mutation => mutation.edits)).toEqual([[{ path: "go/a.go", before: "alpha", after: "beta" }], [{ path: "go/a.go", before: "alpha", after: "beta" }]]);
    const refuse = (text: string, pattern: RegExp) => expect(() => readMutantCatalog(read(text))).toThrow(pattern);
    refuse(catalogText([entry("M01"), entry("M01")]), /Mutant catalog: invalid or duplicate mutant id M01/);
    refuse(catalogText([entry("M1")]), /Mutant catalog: invalid or duplicate mutant id M1/);
    refuse(catalogText([entry("M01", { case: "C99.invented" })]), /M01 cites unknown case C99.invented/);
    refuse(catalogText([entry("M01", { description: " " })]), /M01 has no description/);
    refuse(catalogText([entry("M01", { rationale: " " })]), /M01 has no rationale naming the port lines it edits/);
    refuse(catalogText([entry("M01", { extra: { note: 1 } })]), /M01 has unsupported field note/);
    refuse(catalogText([entry("M01", { go: null })]), /M01 has no Go section/);
    refuse(catalogText([entry("M01", { typescript: { requiredDetections: ["generated", "fixed"] } })]), /M01 requires an unknown TypeScript cohort/);
    refuse(catalogText([entry("M01", { go: { edits: [] } })]), /M01 has no Go edits/);
    refuse(catalogText([entry("M01", { typescript: { edits: [{ path: "test/a.ts", before: "alpha", after: "beta" }] } })]), /M01 edits test\/a.ts outside the TypeScript port/);
    refuse(catalogText([entry("M01", { go: { edits: [{ path: "go/a_test.go", before: "alpha", after: "beta" }] } })]), /M01 edits go\/a_test.go outside the Go port/);
    refuse(catalogText([entry("M01", { typescript: { edits: [{ path: "src/a.ts", before: "alpha", after: "alpha" }] } })]), /M01 has an empty or unchanged edit in src\/a.ts/);
    refuse(catalogText([entry("M01")], 2), /Mutant catalog: expected the versioned catalog formal\/mutations.json/);
    refuse(catalogText([]), /Mutant catalog: expected the versioned catalog formal\/mutations.json/);
    // Anchors are checked apart from the schema: edits apply in order, and every anchor must match the current text exactly once.
    const anchors = (mutations: unknown[]) => { const text = catalogText(mutations); return () => checkMutantAnchors(readMutantCatalog(read(text)), read(text)); };
    const sequential = entry("M01", { typescript: { edits: [{ path: "src/a.ts", before: "alpha", after: "gamma" }, { path: "src/a.ts", before: "gamma = 1", after: "gamma = 2" }] } });
    expect([...anchors([sequential])().keys()].sort()).toEqual(["go/a.go", "src/a.ts"]);
    expect(anchors([entry("M01", { typescript: { edits: [{ path: "src/a.ts", before: "omega", after: "beta" }] } })])).toThrow(/Mutant anchor drift: M01: anchor must match exactly once in src\/a.ts; review the TypeScript port or the catalog/);
    expect(anchors([entry("M01", { typescript: { edits: [{ path: "src/twice.ts", before: "alpha", after: "beta" }] } })])).toThrow(/Mutant anchor drift: M01: anchor must match exactly once in src\/twice.ts/);
    expect(anchors([entry("M01", { go: { edits: [{ path: "go/a.go", before: "omega", after: "beta" }] } })])).toThrow(/Mutant anchor drift: M01: anchor must match exactly once in go\/a.go; review the Go port or the catalog/);
    // The catalog schema is validated for every validation of the manifest; a broken catalog fails it.
    expect(() => validate(manifest(), { catalog: readMutantCatalog(read(catalogText([entry("M01", { rationale: " " })]))) })).toThrow(/Mutant catalog: M01 has no rationale/);
  });

  it("validates reproducer kinds, cited models, declared checkpoints, profile partitions and model-only scope", () => {
    const exported = (edit: (reproducer: Reproducer) => void) => {
      const edited = manifest();
      edit(edited.challenges.find(challenge => challenge.id === "source-budgets-accepts-at-deadline-equality")!.reproducer!);
      return edited;
    };
    const modelRun = (edit: (reproducer: Reproducer) => void) => {
      const edited = manifest();
      edit(edited.challenges.find(challenge => challenge.id === "envelope-strips-unknown-zero-prefix")!.reproducer!);
      return edited;
    };
    const shared = (edit: (reproducer: Reproducer) => void) => {
      const edited = manifest();
      edit(edited.challenges.find(challenge => challenge.id === "stale-recovery-future-candidate")!.reproducer!);
      return edited;
    };
    expect(() => validate(exported(r => { (r as Record<string, unknown>).seed = "0x1"; }))).toThrow(/unsupported reproducer field seed/);
    expect(() => validate(exported(r => { r.kind = "sampled"; }))).toThrow(/reproducer kind must be one of exported-regression, model-run/);
    expect(() => validate(exported(r => { r.run = "inventedTest"; }))).toThrow(/reproducer run is not a scheduled regression of formal\/dialcache-source-budgets-conformance\.qnt: inventedTest/);
    // The declared failure is the condition of one top-level expect in the cited run, compared token by token.
    expect(() => validate(exported(r => { delete (r as Partial<Reproducer>).failure; }))).toThrow(/reproducer failure must state the expect condition the fault breaks/);
    expect(() => validate(exported(r => { r.failure = "s.o.calls == List(CALL_PENDING, DEADLINE_ERROR) and s.o.loaders == 2"; })))
      .toThrow(/defaultSourceBudgetExpiresAtSixtySecondsTest has no top-level expect whose condition is the declared failure/);
    expect(() => validate(exported(r => { r.failure = "s.o.loaders == 2"; }))).toThrow(/has no top-level expect whose condition is the declared failure/);
    expect(validate(exported(r => { r.failure = "s.o.calls==List( DEADLINE_ERROR,CALL_PENDING )\n  and s.o.loaders == 2"; })).reproducers).toBe(13);
    expect(validate(exported(r => { r.failure = "s.o.calls == List(CALL_PENDING)"; })).reproducers).toBe(13);
    expect(() => validate(exported(r => { r.family = "Inclusive Boundary"; }))).toThrow(/reproducer family must be a fault family slug/);
    expect(() => validate(exported(r => { r.profiles = []; }))).toThrow(/reproducer profiles must name known profiles and include source-budgets/);
    expect(() => validate(exported(r => { r.profiles = ["effects"]; }))).toThrow(/must name known profiles and include source-budgets/);
    expect(() => validate(exported(r => { r.profiles = ["source-budgets", "invented"]; }))).toThrow(/must name known profiles and include source-budgets/);
    expect(() => validate(exported(r => { r.exclusions = { invented: "no such profile" }; }))).toThrow(/reproducer exclusion must name an unlisted known profile with a reason: invented/);
    expect(() => validate(exported(r => { r.exclusions = { "source-budgets": "listed and excluded" }; }))).toThrow(/reproducer exclusion must name an unlisted known profile/);
    expect(() => validate(exported(r => { r.exclusions = { effects: "  " }; }))).toThrow(/reproducer exclusion must name an unlisted known profile with a reason: effects/);
    // A shared-library fault partitions every profile between the listed and the excluded.
    expect(() => validate(exported(r => { r.profiles = ["source-budgets", "effects"]; r.exclusions = { independent: "Its sources settle only through explicit deadlines." }; })))
      .toThrow(/a shared-library fault must list or exclude every profile; missing core/);
    expect(validate(exported(r => { r.profiles = ["source-budgets", "effects"]; delete r.exclusions.effects; r.exclusions.independent = "Its sources settle only through explicit deadlines."; })).reproducers).toBe(13);
    expect(() => validate(exported(r => { r.scope = "not model-only"; }))).toThrow(/scope belongs only to a model-run reproducer/);
    // Another profile model's exported run may be cited only for a fault in a shared library.
    const local = (edit: (reproducer: Reproducer) => void) => {
      const edited = manifest();
      edit(edited.challenges.find(challenge => challenge.id === "admission-capacity-off-by-one")!.reproducer!);
      return edited;
    };
    const budgetsRun = { model: "formal/dialcache-source-budgets-conformance.qnt", run: "defaultSourceBudgetExpiresAtSixtySecondsTest", failure: "s.o.calls == List(DEADLINE_ERROR, CALL_PENDING) and s.o.loaders == 2" };
    expect(() => validate(local(r => { Object.assign(r, budgetsRun); })))
      .toThrow(/reproducer model must name another profile model and is allowed only for an exported-regression of a shared-library fault: formal\/dialcache-source-budgets-conformance\.qnt/);
    expect(() => validate(shared(r => { r.model = "formal/dialcache-stale-recovery.qnt"; }))).toThrow(/reproducer model must name another profile model/);
    expect(() => validate(shared(r => { r.model = "formal/dialcache-core.qnt"; }))).toThrow(/reproducer model must name another profile model .*: formal\/dialcache-core\.qnt/);
    expect(() => validate(shared(r => { r.model = "formal/invented.qnt"; }))).toThrow(/reproducer model must name another profile model .*: formal\/invented\.qnt/);
    expect(() => validate(shared(r => { r.kind = "model-run"; r.scope = "Pretend it is model-only."; }))).toThrow(/reproducer model must name another profile model/);
    expect(() => validate(shared(r => { r.run = "localHitDoesNotRenewInsertionTtlTest"; }))).toThrow(/has no top-level expect whose condition is the declared failure/);
    expect(() => validate(shared(r => { r.profiles = ["formal/dialcache-stale-recovery.qnt", "recovery", "shadow"]; r.exclusions.policy = "excluded anyway"; })))
      .toThrow(/must name known profiles and include formal\/dialcache-stale-recovery\.qnt and policy/);
    // A shared-library fault lists or excludes every known profile.
    expect(() => validate(shared(r => { delete r.exclusions.core; delete r.exclusions.layers; }))).toThrow(/a shared-library fault must list or exclude every profile; missing core, layers/);
    expect(validate(shared(r => { delete r.exclusions.layers; r.profiles.push("layers"); })).reproducers).toBe(13);
    // A state-patching run is a scheduled regression but never exported.
    const patching = manifest();
    const effects = patching.challenges.find(challenge => challenge.id === "effects-late-source-accepted")!;
    patching.reproducerBacklog = patching.reproducerBacklog.filter(id => id !== effects.id);
    const budget = "s.phase == SOURCE_RUNNING and s.deadline == 10040 and s.readAborts == 1";
    effects.reproducer = { kind: "exported-regression", run: "followerKeepsAcceptedReadBudgetTest", failure: budget, family: "late-acceptance", profiles: ["effects"], exclusions: {} };
    expect(() => validate(patching)).toThrow(/exported-regression reproducer must cite an exported public-only run of formal\/dialcache-effects-conformance\.qnt: followerKeepsAcceptedReadBudgetTest/);
    effects.reproducer = { kind: "model-run", run: "followerKeepsAcceptedReadBudgetTest", failure: budget, family: "late-acceptance", profiles: ["effects"], exclusions: {}, scope: "Patches the follower budget directly." };
    expect(validate(patching)).toMatchObject({ reproducers: 14, reproducerBacklog: 58 });
    expect(() => validate(modelRun(r => { delete r.scope; }))).toThrow(/model-run reproducer needs a scope/);
    expect(() => validate(modelRun(r => { r.profiles = ["recovery"]; }))).toThrow(/must name known profiles and include formal\/dialcache-envelope-vectors\.qnt/);
    const exportedAsModelRun = manifest();
    const budgets = exportedAsModelRun.challenges.find(challenge => challenge.id === "source-budgets-accepts-at-deadline-equality")!;
    budgets.reproducer = { ...budgets.reproducer!, kind: "model-run", scope: "Pretend it is model-only." };
    expect(() => validate(exportedAsModelRun)).toThrow(/defaultSourceBudgetExpiresAtSixtySecondsTest is exported; cite it as an exported-regression reproducer/);
    const verification = manifest();
    const core = verification.challenges.find(challenge => challenge.id === "core-unhealthy-local-read-hits")!;
    verification.reproducerBacklog = verification.reproducerBacklog.filter(id => id !== core.id);
    core.reproducer = { kind: "exported-regression", run: "localReadFailureContinuesToRemoteTest", family: "unhealthy-read-served", profiles: ["formal/dialcache-core.qnt"], exclusions: {},
      failure: "s.origin == RemoteValue and s.localReads == 1 and s.remoteReads == 1 and s.sourceCalls == 0 and s.localWrites == 0" };
    expect(() => validate(verification)).toThrow(/exported-regression reproducer must cite an exported public-only run of formal\/dialcache-core\.qnt/);
  });

  it("keeps vector artifacts separate from profile histories and validates their provenance boundary", () => {
    for (const changed of [
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.generator = "formal/../outside.mjs"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.artifact = ".formal-traces/derived.json"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.kind = "unknown"; },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.sources = v.sources.filter(path => path !== v.generator); },
      (v: NonNullable<Manifest["models"][number]["vectorExport"]>) => { v.sources.push("src/key.ts"); },
    ]) {
      const invalid = manifest();
      changed(invalid.models.find(model => model.vectorExport)!.vectorExport!);
      expect(() => validate(invalid)).toThrow(/invalid vector export boundary/);
    }
    for (const cases of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = manifest();
      invalid.models.find(model => model.vectorExport)!.vectorExport!.cases = cases;
      expect(() => validate(invalid)).toThrow(/positive bound/);
    }
    const overlap = manifest();
    overlap.models.find(model => model.generate)!.vectorExport = overlap.models.find(model => model.vectorExport)!.vectorExport!;
    expect(() => validate(overlap)).toThrow(/invalid vector export boundary/);
    const duplicate = manifest();
    const vectors = duplicate.models.filter(model => model.vectorExport);
    vectors[1]!.vectorExport!.artifact = vectors[0]!.vectorExport!.artifact;
    expect(() => validate(duplicate)).toThrow(/Duplicate vector generator or artifact/);
  });

  it("scans declarations across whitespace while ignoring comments, strings, and nested values", () => {
    const source = `module example {
      // val falseEvidence = true
      /* run falseTest = init.expect(true) */
      pure val text = "run forgedTest = { val forged = true }"
      val\n        invariant = true
      action init = { val nested = true nested }
      run /* intervening comment */\n        witnessTest = init.expect(invariant)
    }`;
    expect([...scanDeclarations(source)]).toEqual([
      ["text", "val"], ["invariant", "val"], ["init", "action"], ["witnessTest", "run"],
    ]);
    expect(scanDeclarationBodies(source).get("init")!.body).toEqual(["=", "{", "val", "nested", "=", "true", "nested", "}"]);
    expect(scanDeclarationBodies(source).get("text")!.body).toEqual(["=", '"run forgedTest = { val forged = true }"']);
    const invariant = scanDeclarationBodies(source).get("invariant")!;
    expect(invariant.spans.map(([start, end]) => source.slice(start, end))).toEqual(invariant.body);
    expect(() => scanDeclarations("module broken { /* unfinished")).toThrow(/Unterminated/);
    expect(() => scanDeclarations('module broken { val text = "unfinished')).toThrow(/Unterminated/);
    expect(() => scanDeclarations("module broken {} { val forged = true }")).toThrow(/outside the Quint module/);
  });

  it("cuts a run at its declared checkpoint and rejects nested, missing or non-run targets", () => {
    const chain = ["init.then(step)", '        .expect(s == 1 and "mismatch" != "") // first checkpoint', "        .then(all { step, expect(true) }).expect(s == 2)"];
    const source = `module example {\n      action init = all { input' = { name: "init", choice: -1 }, s' = 0 }\n      action step = all { input' = { name: "step", choice: -1 }, s' = s + 1 }\n`
      + `      val invariant = s < 9\n      run chainTest = ${chain.join("\n")}\n      run bareTest = init\n    }`;
    expect(reproducerCheckpoint(source, "chainTest", 's == 1 and "mismatch" != ""')).toEqual({
      before: chain[0], through: `${chain[0]}\n        .expect(s == 1 and "mismatch" != "")`,
    });
    expect(reproducerCheckpoint(source, "chainTest", "s==2")).toEqual({
      before: `${chain[0]}\n${chain[1]}\n        .then(all { step, expect(true) })`, through: chain.join("\n"),
    });
    expect(() => reproducerCheckpoint(source, "chainTest", "true")).toThrow(/chainTest has no top-level expect whose condition is the declared failure/);
    expect(() => reproducerCheckpoint(source, "chainTest", 's == 1 and "other" != ""')).toThrow(/no top-level expect/);
    expect(() => reproducerCheckpoint(source, "chainTest", "  ")).toThrow(/reproducer failure must be an expect condition/);
    expect(() => reproducerCheckpoint(source, "chainTest", undefined)).toThrow(/reproducer failure must be an expect condition/);
    expect(() => reproducerCheckpoint(source, "bareTest", "true")).toThrow(/bareTest has no top-level expect/);
    expect(() => reproducerCheckpoint(source, "invariant", "s < 9")).toThrow(/invariant is not a run declaration/);
    expect(() => reproducerCheckpoint(source, "missingTest", "true")).toThrow(/missingTest is not a run declaration/);
  });

  it("accepts formatted real declarations and rejects a scheduled invariant hidden in a comment", () => {
    const real = manifest();
    // Reformat declaration keywords that no challenge anchor spans; anchors
    // are deliberately checked against the same source text as declarations.
    expect(validateExecution(real, { readSource: path =>
      readFileSync(root + path, "utf8").replace(/\b(run|action)\s+/g, "$1\n    "),
    })).toEqual(validate(real));
    expect(() => validateExecution(real, { readSource: path => {
      const source = readFileSync(root + path, "utf8");
      return path === real.models[0]!.path
        ? source.replace("val " + real.models[0]!.invariants[0], "// val " + real.models[0]!.invariants[0])
        : source;
    } })).toThrow(/scheduled invariant is not a declared val/);
  });

  it("rejects semantic evidence that names an existing but unscheduled helper", () => {
    const catalog = JSON.parse(readFileSync(new URL("../formal/semantic-cases.json", import.meta.url), "utf8"));
    catalog.cases[0].models = ["formal/dialcache-core.qnt:callScopeLive"];
    expect(() => checkSemanticCoverage(catalog)).toThrow(/not scheduled for execution/);
  });

  it("preserves ordered execution, per-profile budgets, seed override, and one closing challenge run", () => {
    const dryRun = (mode: string) => JSON.parse(execFileSync(process.execPath, [runner, mode, "--dry-run"], {
      env: { ...process.env, QUINT_SEED: "0x1234" }, stdio: ["pipe", "pipe", "pipe"],
    }).toString()) as Command[];
    const check = dryRun("check");
    expect(check.filter(job => job.args[0] === "typecheck").map(job => job.args[1])).toEqual(manifest().models.map(model => model.path));
    expect(check.filter(job => job.args[0] === "test").map(job => job.args[1])).toEqual(
      manifest().models.filter(model => model.regressions.length).map(model => model.path),
    );
    // The catalog mutates several models; it runs once after every model has
    // been checked unmodified, never interleaved with a model's own schedule.
    expect(check.filter(job => job.command === "node")).toEqual([{ command: "node", args: ["formal/check-model-properties.mjs"] }]);
    expect(check.at(-1)!.args).toEqual(["formal/check-model-properties.mjs"]);
    for (const job of check.filter(job => job.args[0] === "run")) {
      expect(job.args).toEqual(expect.arrayContaining(["--backend=rust", "--n-threads=1", "--seed=0x1234", "--max-samples=2000", "--max-steps=40"]));
    }
    const generated = dryRun("generate");
    const vectors = generated.filter(job => job.command === "node");
    expect(vectors.map(job => job.args)).toEqual(
      manifest().models.filter(model => model.vectorExport).map(model => [model.vectorExport!.generator, "--check"]),
    );
    // A vector export verifies a committed artifact. It must never inherit the
    // sampled-directory cleanup contract or rewrite expected vectors in CI.
    for (const job of vectors) {
      expect(job.outputDirectory).toBeUndefined();
      expect(job.expectedTraces).toBeUndefined();
      expect(job.args).not.toContain("--write");
    }
    const sampled = generated.filter(job => job.args[0] === "run");
    expect(sampled.map(job => [job.outputDirectory, job.expectedTraces])).toEqual(
      manifest().models.filter(model => model.generate).map(model => [model.generate!.outputDirectory, model.generate!.traces]),
    );
    // Every sampled corpus is bound to its driver contract before use, exactly
    // like the exported regressions; vector and verification jobs bind nothing.
    for (const job of sampled) {
      const model = manifest().models.find(model => model.path === job.args[1])!;
      expect(model.profile, job.args[1]).toBeDefined();
      expect(job.profile, job.args[1]).toBe(model.profile);
      expect(job.explicitInputs, job.args[1]).toBe(model.replayRegressions !== undefined);
    }
    for (const job of [...vectors, ...check]) expect(job.profile, job.args.join(" ")).toBeUndefined();
    const regressions = generated.filter(job => job.args[0] === "test");
    expect(regressions).toHaveLength(manifest().models.filter(model => model.replayRegressions).length);
    for (const job of regressions) {
      const model = manifest().models.find(model => model.path === job.args[1])!;
      expect(job.outputDirectory).toBe(`.formal-traces/regressions/${model.profile}`);
      expect(job.expectedFiles).toEqual(model.replayRegressions!.map(name => `${name}.itf.json`));
      expect(job.expectedTraces).toBe(model.replayRegressions!.length);
      expect(job.explicitInputs).toBe(true);
      expect(job.profile).toBe(model.profile);
      expect(job.args).toEqual(expect.arrayContaining(["--max-samples=1", "--seed=0x1234", `--match=^(${model.replayRegressions!.join("|")})$`]));
    }
    expect(generated[0]!.args).toEqual(expect.arrayContaining(["--max-samples=256", "--max-steps=30", "--seed=0x1234"]));
    expect(sampled.find(job => job.outputDirectory === ".formal-traces/features/layers")!.args).toEqual(expect.arrayContaining(["--max-samples=2048", "--max-steps=80"]));
  });
});
