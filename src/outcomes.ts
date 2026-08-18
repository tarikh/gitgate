// The outcome vocabulary is the product. Every state below is a distinct fact
// about what happened to the model's work, and the CLI, the JSON output, and
// the exit code all speak it. Nothing here is ever reported before the remote
// has proven it.

export type OutcomeStatus =
  | "pushed" // audited changes landed on the configured branch — verified on the remote
  | "clean" // write run finished with nothing to land
  | "audited" // dry run: changes passed policy, publication deliberately skipped
  | "replied" // read-only run finished; any workspace writes were discarded
  | "parked" // remote conflict; work preserved on a park branch, verified there
  | "queued" // publication is ambiguous or failed; work retained locally, never auto-retried
  | "rejected" // the model's write set violated policy; nothing published
  | "timed_out" // engine killed at the deadline; nothing audited, nothing published
  | "failed"; // engine or infrastructure failure; nothing published

export interface OutcomeBase {
  status: OutcomeStatus;
  job: string;
  mode: "read-only" | "write";
  dryRun: boolean;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** repo-relative paths that were audited and (where applicable) published */
  changedPaths: string[];
  /** ignored-file writes dropped under policy.ignored_files: discard */
  discardedPaths: string[];
  /** the engine's final message (output file, else stdout) */
  reply?: string;
  engineExit?: { code: number | null; signal: string | null };
  /** absolute path of the retained run directory, when work is kept for a human */
  retainedRun?: string;
  /** free-text explanation for non-success states */
  reason?: string;
}

export type RunOutcome =
  | (OutcomeBase & { status: "pushed"; sha: string; branch: string })
  | (OutcomeBase & { status: "clean" })
  | (OutcomeBase & { status: "audited" })
  | (OutcomeBase & { status: "replied" })
  | (OutcomeBase & { status: "parked"; sha: string; parkBranch: string; branch: string })
  | (OutcomeBase & { status: "queued"; reason: string; retainedRun: string })
  | (OutcomeBase & { status: "rejected"; reason: string })
  | (OutcomeBase & { status: "timed_out"; reason: string })
  | (OutcomeBase & { status: "failed"; reason: string });

/** Process exit codes: 0 done, 2 needs a human, 3 policy, 4 deadline, 1 failure. */
export function exitCodeFor(status: OutcomeStatus): number {
  switch (status) {
    case "pushed":
    case "clean":
    case "audited":
    case "replied":
      return 0;
    case "parked":
    case "queued":
      return 2;
    case "rejected":
      return 3;
    case "timed_out":
      return 4;
    case "failed":
      return 1;
  }
}

/** One human-readable line. Success states say what landed; the rest say what did not. */
export function describeOutcome(o: RunOutcome): string {
  const n = o.changedPaths.length;
  const files = `${n} file${n === 1 ? "" : "s"}`;
  switch (o.status) {
    case "pushed":
      return `pushed ${files} to ${o.branch} @ ${o.sha.slice(0, 10)} (verified on remote)`;
    case "clean":
      return "clean — the engine changed nothing to publish";
    case "audited":
      return `audited ${files}: policy passed, publication skipped (dry run)`;
    case "replied":
      return `replied${n ? ` — ${files} written by the engine were discarded (read-only run)` : ""}`;
    case "parked":
      return `NOT on ${o.branch}: conflicting work is parked on ${o.parkBranch} @ ${o.sha.slice(0, 10)} and needs a human merge`;
    case "queued":
      return `NOT published — ${o.reason}. Work retained at ${o.retainedRun}; it will not retry automatically`;
    case "rejected":
      return `rejected by policy — ${o.reason}${o.retainedRun ? ` (kept at ${o.retainedRun})` : ""}`;
    case "timed_out":
      return `timed out — ${o.reason}. Nothing was audited or published${o.retainedRun ? ` (kept at ${o.retainedRun})` : ""}`;
    case "failed":
      return `failed — ${o.reason}${o.retainedRun ? ` (kept at ${o.retainedRun})` : ""}`;
  }
}
