// The trusted publisher. It stages exactly the audited paths, commits, and
// lands the commit on the configured branch — and it NEVER LIES: `pushed` is
// returned only after proving the commit is an ancestor of the remote branch,
// `clean` only after proving there is nothing to land. On a real conflict it
// NEVER LOSES: the commit is pushed to a park branch and confirmed there before
// the run reports anything, and it is never resolved or retried automatically
// because a deterministic conflict re-runs identically every time.
//
// Ported from Kubrick's writer.ts, minus the parts that only matter for a
// long-lived shared clone (stale locks, salvage, detached-HEAD repair): a
// disposable clone is born clean and dies after one publication.
import { git, gitOk, stamp } from "./git.js";

export type PublishResult =
  | { status: "pushed"; sha: string }
  | { status: "clean" }
  | { status: "parked"; branch: string; sha: string }
  | { status: "queued"; reason: string };

export interface PublishOptions {
  branch: string;
  message: string;
  paths: string[];
  retries?: number;
  parkPrefix?: string;
  log?: (line: string) => void;
}

export async function publish(checkout: string, opts: PublishOptions): Promise<PublishResult> {
  try {
    return await land(checkout, opts);
  } catch (err) {
    return { status: "queued", reason: (err as Error).message };
  }
}

async function land(checkout: string, opts: PublishOptions): Promise<PublishResult> {
  const { branch, message, paths } = opts;
  const retries = opts.retries ?? 3;
  const parkPrefix = opts.parkPrefix ?? "gitgate/parked";
  const log = opts.log ?? (() => {});
  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetchBranch = () => git(checkout, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:${remoteRef}`);
  const aheadCount = async () => Number((await git(checkout, "rev-list", "--count", `${remoteRef}..HEAD`)).trim()) || 0;
  const head = async () => (await git(checkout, "rev-parse", "HEAD")).trim();

  // Never `git add -A`: stage exactly what the audit approved. `add` stages
  // deletions of tracked paths too, so approved deletions need no special case.
  if (paths.length) await git(checkout, "add", "--", ...paths);
  let committed: string | undefined;
  if ((await git(checkout, "diff", "--cached", "--name-only")).trim()) {
    await git(checkout, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", message);
    committed = await head();
  }

  for (let attempt = 1; ; attempt++) {
    await fetchBranch();
    if ((await aheadCount()) === 0) {
      // Nothing left to land. If our commit is already on the remote (a push
      // that "failed" after the server accepted it), that is a push, not clean.
      if (committed && (await gitOk(checkout, "merge-base", "--is-ancestor", committed, remoteRef))) {
        return { status: "pushed", sha: committed };
      }
      return { status: "clean" };
    }

    if (await gitOk(checkout, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`)) {
      await fetchBranch();
      if (await gitOk(checkout, "merge-base", "--is-ancestor", "HEAD", remoteRef)) {
        return { status: "pushed", sha: await head() };
      }
      log("gitgate: push reported success but HEAD is not on the remote branch");
    }

    if (attempt >= retries) {
      return { status: "queued", reason: `push did not land after ${attempt} attempt(s)` };
    }

    // Someone else landed a commit while the engine worked. Replay onto the
    // stable remote ref (never FETCH_HEAD, which can hold several entries).
    const tip = await head();
    if (!(await gitOk(checkout, "rebase", "--quiet", remoteRef))) {
      await gitOk(checkout, "rebase", "--abort");
      return park(checkout, tip, branch, parkPrefix, log);
    }
  }
}

/** Preserve `sha` on a remote park branch and prove it is there. Push, prove, then report. */
async function park(checkout: string, sha: string, branch: string, parkPrefix: string, log: (l: string) => void): Promise<PublishResult> {
  const parkBranch = `${parkPrefix}/${stamp()}`;
  try {
    await git(checkout, "push", "--quiet", "origin", `${sha}:refs/heads/${parkBranch}`);
    // A name-only check would accept a same-second collision pointing at
    // someone else's object; verify the SHA.
    const seen = (await git(checkout, "ls-remote", "--heads", "origin", parkBranch)).trim();
    if (seen.split(/\s+/)[0] !== sha) {
      throw new Error(`park branch missing or points elsewhere: ${seen || "(absent)"}`);
    }
  } catch (err) {
    return { status: "queued", reason: `conflict with ${branch}, and parking failed — ${(err as Error).message}` };
  }
  log(`gitgate: parked ${sha.slice(0, 10)} on ${parkBranch}`);
  return { status: "parked", branch: parkBranch, sha };
}
