import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Reproducer = { kind: string; run: string; model?: string; failure: string; family: string; profiles: string[]; exclusions: Record<string, string>; scope?: string };
type Challenge = { id: string; contract: string; source: string; model: string; invariant: string; before: string; after: string; measures?: string; reproducer?: Reproducer };
type Manifest = {
  check: { maxSamples: number; maxSteps: number; outputDirectory: string };
  libraries: string[];
  challenges: Challenge[];
  reproducerBacklog: string[];
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
const { root, scanDeclarations, scanDeclarationBodies, classifyRuns, reproducerCheckpoint, validateExecution } = await import(moduleUrl) as {
  root: string;
  scanDeclarations(source: string): Map<string, string>;
  scanDeclarationBodies(source: string): Map<string, { kind: string; body: string[]; spans: Array<[number, number]> }>;
  classifyRuns(declarations: Map<string, { kind: string; body: string[] }>): { publicOnly: string[]; patching: string[] };
  reproducerCheckpoint(source: string, run: string, failure: unknown): { before: string; through: string };
  validateExecution(value: unknown, options?: { readSource(path: string): string }): Record<string, number>;
};
const { checkSemanticCoverage } = await import(new URL("../formal/check-semantic-coverage.mjs", import.meta.url).href) as {
  checkSemanticCoverage(value: unknown): unknown;
};
const { bindGeneratedTrace } = await import(new URL("../formal/run-models.mjs", import.meta.url).href) as {
  bindGeneratedTrace(profile: string, text: string, path: string): void;
};
// Exercise pure metadata checks directly: large catalogs must not depend on
// synchronous stdin pipes. The CLI dry-run check below still tests the launcher.
const validate = (value: unknown) => validateExecution(value);

describe("formal execution schedule", () => {
  it("accounts for all models, selected invariants, regressions, generated traces and challenges without Quint", () => {
    expect(validate(manifest())).toEqual({ models: 32, libraries: 5, profiles: 15, invariants: 217, regressions: 406,
      generatedTraces: 5280, exportedRegressionTraces: 239, vectorModels: 4, generatedVectors: 1631,
      challenges: 67, distinctFaults: 64, challengedModels: 32, waivedModels: 0, reproducers: 7, reproducerBacklog: 60 });
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
    expect(() => validate(repeated)).toThrow(/repeated-fault: repeats the fault of .* without a measures note/);
    repeated.challenges.at(-1)!.measures = "Measures the same fault against a second invariant.";
    expect(validate(repeated).distinctFaults).toBe(validate(manifest()).distinctFaults);
    const strayNote = manifest();
    strayNote.challenges.find(challenge => !challenge.measures)!.measures = "not a repeat";
    expect(() => validate(strayNote)).toThrow(/a measures note is only for a repeated fault/);
  });

  it("requires a challenge for every scheduled model unless the model carries an explicit waiver", () => {
    const uncovered = manifest();
    const target = uncovered.models.find(model => model.path === "formal/dialcache-core.qnt")!;
    uncovered.challenges = uncovered.challenges.filter(challenge => challenge.model !== target.path);
    uncovered.reproducerBacklog = uncovered.reproducerBacklog.filter(id => uncovered.challenges.some(challenge => challenge.id === id));
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
      "policy-inclusive-local-expiry", "shadow-inclusive-c0-freshness", "admission-capacity-off-by-one", "local-clock-precise-ttl",
      "stale-recovery-future-candidate", "envelope-strips-unknown-zero-prefix", "source-budgets-accepts-at-deadline-equality",
    ]);
    expect(withReproducer.map(challenge => challenge.reproducer!.kind)).toEqual([
      "exported-regression", "exported-regression", "exported-regression", "exported-regression", "exported-regression", "model-run", "exported-regression",
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
    const duplicate = manifest();
    duplicate.reproducerBacklog.push(duplicate.reproducerBacklog[0]!);
    expect(() => validate(duplicate)).toThrow(/Duplicate challenge ids in reproducerBacklog/);
    const missing = manifest();
    delete (missing as Partial<Manifest>).reproducerBacklog;
    expect(() => validate(missing)).toThrow(/reproducer backlog is missing/);
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
    expect(validate(exported(r => { r.failure = "s.o.calls==List( DEADLINE_ERROR,CALL_PENDING )\n  and s.o.loaders == 2"; })).reproducers).toBe(7);
    expect(validate(exported(r => { r.failure = "s.o.calls == List(CALL_PENDING)"; })).reproducers).toBe(7);
    expect(() => validate(exported(r => { r.family = "Inclusive Boundary"; }))).toThrow(/reproducer family must be a fault family slug/);
    expect(() => validate(exported(r => { r.profiles = []; }))).toThrow(/reproducer profiles must name known profiles and include source-budgets/);
    expect(() => validate(exported(r => { r.profiles = ["effects"]; }))).toThrow(/must name known profiles and include source-budgets/);
    expect(() => validate(exported(r => { r.profiles = ["source-budgets", "invented"]; }))).toThrow(/must name known profiles and include source-budgets/);
    expect(() => validate(exported(r => { r.exclusions = { invented: "no such profile" }; }))).toThrow(/reproducer exclusion must name an unlisted known profile with a reason: invented/);
    expect(() => validate(exported(r => { r.exclusions = { "source-budgets": "listed and excluded" }; }))).toThrow(/reproducer exclusion must name an unlisted known profile/);
    expect(() => validate(exported(r => { r.exclusions = { effects: "  " }; }))).toThrow(/reproducer exclusion must name an unlisted known profile with a reason: effects/);
    expect(validate(exported(r => { r.profiles = ["source-budgets", "effects"]; r.exclusions = { independent: "Its sources settle only through explicit deadlines." }; })).reproducers).toBe(7);
    expect(() => validate(exported(r => { r.scope = "not model-only"; }))).toThrow(/scope belongs only to a model-run reproducer/);
    // Another profile model's exported run may be cited only for a fault in a shared library.
    const policy = { model: "formal/dialcache-policy-conformance.qnt", run: "wallRollbackRejectsFutureRemoteFrameTest", failure: "s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.loaders == 2" };
    expect(() => validate(exported(r => { Object.assign(r, policy); })))
      .toThrow(/reproducer model must name another profile model and is allowed only for an exported-regression of a shared-library fault: formal\/dialcache-policy-conformance\.qnt/);
    expect(() => validate(shared(r => { r.model = "formal/dialcache-stale-recovery.qnt"; }))).toThrow(/reproducer model must name another profile model/);
    expect(() => validate(shared(r => { r.model = "formal/dialcache-core.qnt"; }))).toThrow(/reproducer model must name another profile model .*: formal\/dialcache-core\.qnt/);
    expect(() => validate(shared(r => { r.model = "formal/invented.qnt"; }))).toThrow(/reproducer model must name another profile model .*: formal\/invented\.qnt/);
    expect(() => validate(shared(r => { r.kind = "model-run"; r.scope = "Pretend it is model-only."; }))).toThrow(/reproducer model must name another profile model/);
    expect(() => validate(shared(r => { r.run = "localHitDoesNotRenewInsertionTtlTest"; }))).toThrow(/has no top-level expect whose condition is the declared failure/);
    expect(() => validate(shared(r => { r.profiles = ["formal/dialcache-stale-recovery.qnt", "recovery", "shadow"]; r.exclusions.policy = "excluded anyway"; })))
      .toThrow(/must name known profiles and include formal\/dialcache-stale-recovery\.qnt and policy/);
    // A shared-library fault lists or excludes every known profile.
    expect(() => validate(shared(r => { delete r.exclusions.core; delete r.exclusions.layers; }))).toThrow(/a shared-library fault must list or exclude every profile; missing core, layers/);
    expect(validate(shared(r => { delete r.exclusions.layers; r.profiles.push("layers"); })).reproducers).toBe(7);
    // A state-patching run is a scheduled regression but never exported.
    const patching = manifest();
    const effects = patching.challenges.find(challenge => challenge.id === "effects-late-source-accepted")!;
    patching.reproducerBacklog = patching.reproducerBacklog.filter(id => id !== effects.id);
    const budget = "s.phase == SOURCE_RUNNING and s.deadline == 10040 and s.readAborts == 1";
    effects.reproducer = { kind: "exported-regression", run: "followerKeepsAcceptedReadBudgetTest", failure: budget, family: "late-acceptance", profiles: ["effects"], exclusions: {} };
    expect(() => validate(patching)).toThrow(/exported-regression reproducer must cite an exported public-only run of formal\/dialcache-effects-conformance\.qnt: followerKeepsAcceptedReadBudgetTest/);
    effects.reproducer = { kind: "model-run", run: "followerKeepsAcceptedReadBudgetTest", failure: budget, family: "late-acceptance", profiles: ["effects"], exclusions: {}, scope: "Patches the follower budget directly." };
    expect(validate(patching)).toMatchObject({ reproducers: 8, reproducerBacklog: 59 });
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
