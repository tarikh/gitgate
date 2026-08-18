// The job lifecycle. Read this top to bottom and you have the whole contract:
//
//   prepare   fresh clone == remote branch tip; trusted .git moved out of reach
//   engine    any command, sanitised env, own process group, hard deadline
//   restore   trusted .git back; model-created Git state quarantined
//   audit     write set from git status/ls-files, checked against policy
//   publish   stage exactly the audited paths, commit, push, PROVE, or park
//   report    one of nine outcomes; retained work is never silently retried
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditWorkspace, PolicyViolation } from "./audit.js";
import { readReply, runEngine, type EngineContext, type EngineResult } from "./engine.js";
import { firstLine } from "./git.js";
import { describeOutcome, type OutcomeBase, type RunOutcome } from "./outcomes.js";
import { parseDuration, type JobConfig } from "./policy.js";
import { publish } from "./publisher.js";
import { createRunsManager, MARKERS, type RunsManager, type Workspace } from "./workspace.js";

export interface RunOptions {
  /** Overrides job.prompt. One of the two is required. */
  prompt?: string;
  /** Do everything except publish. Only meaningful for write jobs. */
  dryRun?: boolean;
  /** Retain the run directory even for rejected / timed-out / failed / clean runs. */
  keep?: boolean;
  /** Overrides job.runs_dir. */
  runsDir?: string;
  log?: (line: string) => void;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

/** Run one job to a single, truthful outcome. Never throws for engine or Git behaviour. */
export async function runJob(job: JobConfig, opts: RunOptions = {}): Promise<RunOutcome> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const startedAt = new Date();
  const prompt = opts.prompt ?? job.prompt;
  const dryRun = Boolean(opts.dryRun) && job.mode === "write";
  const timeoutMs = parseDuration(job.timeout);
  const runs = createRunsManager({ runsDir: opts.runsDir ?? job.runs_dir, queuedRunCap: job.queued_run_cap, log });

  const base = (runId: string): OutcomeBase => ({
    status: "failed",
    job: job.name,
    mode: job.mode,
    dryRun,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    changedPaths: [],
    discardedPaths: [],
  });

  if (!prompt) return { ...base("none"), status: "failed", reason: "no prompt: pass --prompt or set job.prompt" };

  let ws: Workspace;
  try {
    ws = await runs.prepare({
      repo: job.repo,
      branch: job.branch,
      authorName: job.publish.author_name,
      authorEmail: job.publish.author_email,
    });
  } catch (err) {
    return { ...base("none"), status: "failed", reason: `could not prepare workspace: ${firstLine(err)}` };
  }

  runs.marker(ws.runDir, MARKERS.job, {
    job: job.name,
    mode: job.mode,
    dryRun,
    branch: job.branch,
    origin: ws.originUrl,
    base: ws.base,
    startedAt: startedAt.toISOString(),
    prompt: prompt.length > 2000 ? `${prompt.slice(0, 2000)}…` : prompt,
  });
  const promptFile = join(ws.runDir, "prompt.txt");
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  const logDir = join(ws.runDir, "logs");
  mkdirSync(logDir, { mode: 0o700 });
  const ctx: EngineContext = {
    jobName: job.name,
    mode: job.mode,
    workspace: ws.checkout,
    promptFile,
    prompt,
    outputFile: join(ws.runDir, "reply.txt"),
    logDir,
    tmpDir: ws.tmpDir,
  };

  let retain = false;
  let outcome: RunOutcome;
  try {
    outcome = await execute(job, ws, ctx, runs, timeoutMs, dryRun, base, log, opts.onOutput);
  } catch (err) {
    // Infrastructure failure. Restore trusted Git if the engine phase left it out.
    let reason = firstLine(err);
    let restoreFailed = false;
    try {
      runs.restoreTrustedGit(ws);
    } catch (restoreErr) {
      restoreFailed = true;
      reason = `Git restoration failed after: ${reason} — ${firstLine(restoreErr)}`;
    }
    if (restoreFailed) {
      runs.markQueued(ws.runDir, reason);
      outcome = { ...base(ws.runId), status: "queued", reason, retainedRun: ws.runDir };
    } else {
      outcome = { ...base(ws.runId), status: "failed", reason };
    }
  }

  // Retention: queued work is always kept (that is what queued means); anything
  // else is kept only on request. Parked work already lives on the remote.
  if (outcome.status === "queued") retain = true;
  else if (opts.keep && outcome.status !== "pushed" && outcome.status !== "parked") retain = true;

  outcome.finishedAt = new Date().toISOString();
  outcome.durationMs = Date.now() - startedAt.getTime();
  if (retain) {
    outcome.retainedRun = ws.runDir;
    runs.marker(ws.runDir, MARKERS.outcome, outcome);
    if (outcome.status !== "queued") runs.markDone(ws.runDir);
  } else {
    runs.remove(ws.runDir);
  }
  log(`gitgate: ${job.name} — ${describeOutcome(outcome)}`);
  return outcome;
}

async function execute(
  job: JobConfig,
  ws: Workspace,
  ctx: EngineContext,
  runs: RunsManager,
  timeoutMs: number,
  dryRun: boolean,
  base: (runId: string) => OutcomeBase,
  log: (line: string) => void,
  onOutput?: RunOptions["onOutput"],
): Promise<RunOutcome> {
  const engineResult: EngineResult = await runEngine(job.engine, ctx, timeoutMs, onOutput);
  const modelGit = runs.restoreTrustedGit(ws); // always, before anything else is decided
  const reply = readReply(ctx, engineResult);
  const common = (): OutcomeBase => ({
    ...base(ws.runId),
    reply,
    engineExit: { code: engineResult.code, signal: engineResult.signal },
  });

  if (engineResult.timedOut) {
    return {
      ...common(),
      status: "timed_out",
      reason: `engine exceeded ${Math.round(timeoutMs / 1000)}s and its process group was killed`,
    };
  }
  if (engineResult.overflow) {
    return { ...common(), status: "failed", reason: "engine output exceeded the 32 MB capture limit" };
  }
  if (engineResult.code !== 0) {
    const diag = firstLine(engineResult.stderrTail.trim() || engineResult.stdoutTail.trim() || "no diagnostic output");
    return {
      ...common(),
      status: "failed",
      reason: `engine exited ${engineResult.code ?? engineResult.signal ?? "unknown"}: ${diag}`,
    };
  }

  if (job.mode === "read-only") {
    // Whatever the engine wrote is discarded with the clone. Say so.
    const written = await runs.changedPaths(ws.checkout);
    return { ...common(), status: "replied", changedPaths: written };
  }

  if (modelGit.length) {
    return { ...common(), status: "rejected", reason: `model-created Git state quarantined: ${modelGit.join(", ")}` };
  }

  let audited;
  try {
    audited = await auditWorkspace({ checkout: ws.checkout, base: ws.base }, job.policy!);
  } catch (err) {
    if (err instanceof PolicyViolation) return { ...common(), status: "rejected", reason: err.message };
    throw err;
  }
  const withPaths = (): OutcomeBase => ({ ...common(), changedPaths: audited.approved, discardedPaths: audited.discarded });

  if (dryRun) {
    return audited.approved.length ? { ...withPaths(), status: "audited" } : { ...withPaths(), status: "clean" };
  }
  if (!audited.approved.length) return { ...withPaths(), status: "clean" };

  const message = job.publish.commit_message ?? `${job.name}: automated update`;
  const result = await publish(ws.checkout, {
    branch: ws.branch,
    message,
    paths: audited.approved,
    retries: job.publish.retries,
    parkPrefix: job.publish.park_prefix,
    log,
  });
  switch (result.status) {
    case "pushed":
      return { ...withPaths(), status: "pushed", sha: result.sha, branch: ws.branch };
    case "clean":
      return { ...withPaths(), status: "clean" };
    case "parked":
      return { ...withPaths(), status: "parked", sha: result.sha, parkBranch: result.branch, branch: ws.branch };
    case "queued":
      runs.markQueued(ws.runDir, result.reason);
      return { ...withPaths(), status: "queued", reason: result.reason, retainedRun: ws.runDir };
  }
}

