const VERDICTS = ["approve", "approve-with-nits", "request-changes"];

export function reviewBlocking(reviewResult) {
  if (!reviewResult || typeof reviewResult !== "object" || Array.isArray(reviewResult)) {
    return { fatal: "review result missing or malformed" };
  }
  if (!VERDICTS.includes(reviewResult.verdict)) {
    return { fatal: `unknown verdict: ${String(reviewResult.verdict)}` };
  }
  const findings = Array.isArray(reviewResult.findings) ? reviewResult.findings : [];
  const blockingFindings = findings.filter((f) => f.severity === "P0" || f.severity === "P1");
  if (reviewResult.verdict === "request-changes" || blockingFindings.length) {
    return { blocking: true, reason: `verdict=${reviewResult.verdict} P0/P1=${blockingFindings.length}`, findings };
  }
  return { blocking: false, findings };
}

// A moved head gets one re-assessment; a second move means something is racing
// the loop and merging would ship unreviewed commits — stop instead.
const HEAD_REASSESSMENT_LIMIT = 1;

export async function runLoop(deps) {
  const {
    readStatus, preflight, runWorker, workerGates, runReviewer, runDogfood, runFixer,
    merge, postMergeGates,
    // Not wiring a head re-fetch fails closed: the loop refuses to merge a head
    // it cannot pin.
    fetchPrHead = async () => ({ error: "fetchPrHead not wired" }),
    dogfood = false, mergeMode = "human", maxIterations = 1, cooldownSeconds = 60,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = deps;
  const summary = { stopped: "failure", reason: "", iterations: [] };
  const short = (value) => String(value).slice(0, 7);

  const fail = (reason) => { summary.reason = reason; return summary; };
  const finishAs = (stopped, reason) => { summary.stopped = stopped; summary.reason = reason; return summary; };

  for (let index = 0; index < maxIterations; index++) {
    // Status is read before an iteration is recorded: terminal statuses must
    // leave iterations empty ("without dispatching anything").
    const status = await readStatus();
    if (status.kind === "done") return finishAs("done", "ROADMAP complete");
    if (status.kind === "blocked") return finishAs("blocked", status.reason);
    if (status.kind !== "next") return fail(`HANDOFF STATUS is ${status.kind}: ${status.line ?? ""}`.trim());

    const iteration = { increment: status.increment, prNumber: null, fixerRounds: 0, merged: false, outcome: "" };
    summary.iterations.push(iteration);
    log(`increment ${iteration.increment}: preflight`);

    const pre = await preflight(status);
    const preFail = pre.find((g) => !g.ok);
    if (preFail) return fail(`preflight gate ${preFail.name}: ${preFail.detail}`);

    const worker = await runWorker(status);
    if (worker.code !== 0 || worker.timedOut) return fail(`worker failed (code=${worker.code}, timedOut=${worker.timedOut})`);

    let fixerBudget = 2;
    // assess(): gates + all active reviews. Returns fatal / blocking / clean.
    const assess = async () => {
      const gates = await workerGates();
      const gateFail = gates.results.find((g) => !g.ok);
      if (gateFail) {
        return { kind: "blocking", reason: `gate ${gateFail.name}: ${gateFail.detail}`,
                 findings: gates.results.filter((g) => !g.ok).map((g) => ({ severity: "P0", title: `${g.name}: ${g.detail}` })) };
      }
      iteration.prNumber = gates.prNumber;
      const reviewRuns = [{ name: "independent", result: await runReviewer(gates.prNumber) }];
      if (dogfood) reviewRuns.push({ name: "dogfood", result: await runDogfood(gates.prNumber) });
      for (const run of reviewRuns) {
        if (run.result.code !== 0 || run.result.timedOut) {
          return { kind: "fatal", reason: `${run.name} review invocation failed (code=${run.result.code}, timedOut=${run.result.timedOut})` };
        }
      }
      const judgments = reviewRuns.map((run) => ({ name: run.name, judgment: reviewBlocking(run.result.review) }));
      const fatal = judgments.find((j) => j.judgment.fatal);
      if (fatal) return { kind: "fatal", reason: `${fatal.name} review: ${fatal.judgment.fatal}` };
      const blocking = judgments.filter((j) => j.judgment.blocking);
      if (blocking.length) {
        return { kind: "blocking",
                 reason: blocking.map((j) => `${j.name}: ${j.judgment.reason}`).join("; "),
                 findings: blocking.flatMap((j) => j.judgment.findings) };
      }
      return { kind: "clean", headRefOid: gates.headRefOid ?? null };
    };

    let state = await assess();
    let headMoves = 0;
    // Clean assessment → merge decision. In auto mode the loop merges only the
    // exact head the reviews assessed (spec, architecture step 7): a moved head
    // re-enters assessment instead of merging unreviewed commits.
    for (;;) {
      while (state.kind === "blocking") {
        // Gate failures with no known PR (e.g. increment-pr: 0 or ≥2 open PRs) are
        // not fixable by a PR-scoped fixer — stop instead of dispatching garbage.
        if (iteration.prNumber === null) return fail(`blocking state with no known PR, not fixable: ${state.reason}`);
        if (fixerBudget === 0) return fail(`unresolved after fixer budget: ${state.reason}`);
        fixerBudget -= 1;
        iteration.fixerRounds += 1;
        log(`fixer round ${iteration.fixerRounds}: ${state.reason}`);
        const fixed = await runFixer(iteration.prNumber, state.findings);
        if (fixed.code !== 0 || fixed.timedOut) return fail(`fixer failed (code=${fixed.code}, timedOut=${fixed.timedOut})`);
        state = await assess();
      }
      if (state.kind === "fatal") return fail(state.reason);
      iteration.outcome = "clean";

      if (mergeMode !== "auto") {
        summary.stopped = "awaiting-human-merge";
        summary.reason = `PR #${iteration.prNumber} gates+review clean; merge=${mergeMode} — human merges`;
        return summary;
      }
      if (state.headRefOid == null) return fail(`PR #${iteration.prNumber} assessed with unknown head; refusing to merge`);
      const current = await fetchPrHead(iteration.prNumber);
      if (!current || current.error || !current.headRefOid) {
        return fail(`cannot pin PR #${iteration.prNumber} head before merge: ${current?.error ?? "headRefOid missing"}`);
      }
      if (current.headRefOid === state.headRefOid) {
        iteration.reviewedHeadOid = state.headRefOid;
        break;
      }
      headMoves += 1;
      if (headMoves > HEAD_REASSESSMENT_LIMIT) {
        return fail(`PR #${iteration.prNumber} head moved again after re-assessment (${short(state.headRefOid)} → ${short(current.headRefOid)}); not merging unreviewed commits`);
      }
      log(`PR #${iteration.prNumber} head moved ${short(state.headRefOid)} → ${short(current.headRefOid)} after assessment; re-assessing`);
      state = await assess();
    }
    const merged = await merge(iteration.prNumber);
    if (merged.code !== 0) return fail(`merge failed for PR #${iteration.prNumber}: ${merged.stderr.slice(0, 200)}`);
    iteration.merged = true;
    const post = await postMergeGates();
    const postFail = post.find((g) => !g.ok);
    if (postFail) return fail(`main red after merge — ${postFail.name}: ${postFail.detail} (human decides revert vs fix-forward)`);
    iteration.outcome = "merged";
    if (index + 1 < maxIterations) await sleep(cooldownSeconds * 1000);
  }
  summary.stopped = "completed";
  summary.reason = `${maxIterations} iteration(s) finished`;
  return summary;
}
