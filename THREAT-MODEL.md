# Threat model

gitgate makes one promise and is careful not to imply a bigger one:

> **A model run through gitgate cannot publish anything to your branch except
> regular-file changes, in paths your policy allows, that trusted code has
> staged, committed, pushed and verified — and cannot make gitgate report that
> it did when it didn't.**

Everything below is about the edges of that promise.

## What is protected

**The repository surface.** For the configured branch of the configured remote:

- No commit, push, force-push, tag, branch, hook, or config change originates
  from the model. Trusted `.git` is physically outside the tree it runs in, and
  any Git state it creates is quarantined and rejects the run.
- No path outside `policy.allow`, no path in `policy.deny`, no deletion,
  executable, symlink, non-regular file, changed tracked mode, gitlink or
  ignored file reaches the branch unless the policy explicitly allows that class.
- The write set is computed from Git on the restored checkout — not from the
  model's tool events, stdout, or claims.
- Publication is by trusted code and is proven on the remote before `pushed` is
  reported. Conflicts park; failures queue; nothing ambiguous is retried or
  destroyed silently.
- The engine cannot outlive its deadline: it runs in its own process group and
  the whole group is SIGKILLed.
- The engine's environment is an allowlist. Secrets in gitgate's own environment
  (the publisher's deploy key, an unrelated token) do not reach the model
  unless `engine.pass_env` names them.

## What is NOT protected — and what to do about it

### 1. Anything the engine's Unix user can read

The engine runs as the same user as gitgate, with `HOME` set to that user's
home by default (because Codex CLI and Claude Code keep their logins there).
It can therefore read `~/.ssh`, `~/.aws`, other repositories, `/etc`, and
whatever else that user can. gitgate does not sandbox the filesystem.

*Mitigation tiers, in increasing strength:*
- Set `engine.home` to a dedicated directory containing only the engine's own
  auth, so the default HOME is not yours. This stops the *casual* case (a tool
  that reads `~/.config/…` by habit), not a determined one — same Unix user,
  same file permissions.
- Run gitgate as a **dedicated Unix user** (see `examples/systemd/`) that owns
  nothing but the engine's auth and the publisher's deploy key. Be honest about
  what that buys: the model can still read that user's deploy key. So make the
  key a *deploy key scoped to that one repository*, and rely on branch
  protection on the remote for anything the key must not be able to do.
- Use the engine's own sandbox where it has one (Codex `--sandbox
  workspace-write` with network off; Claude Code's tool allowlist).
- Run the engine in a **container or VM** with only the checkout mounted, and
  keep gitgate and the deploy key outside it. This is the only tier where "the
  model can't read X" is a strong claim. gitgate's engine-is-a-command design
  makes this a one-line change to `engine.command` (`docker run -v
  {workspace}:/work …`).

### 2. Content in allowed paths

Path/mode policy says nothing about *what* is written. A model can put wrong,
misleading, or malicious prose in `docs/`, a backdoor in an allowed `src/`
file, or a secret it read into an allowed file. gitgate will publish it if the
policy allows the path.

*Mitigation:* keep allow-lists as narrow as the job — a docs job gets `docs/`,
not `**`. Publish to a branch and open a PR for anything humans should read
first. Add your own content checks around gitgate (secret scanners, linters,
tests) — it exposes `auditWorkspace` and `publish` separately so you can put a
step between them.

### 3. Prompt injection from the repository

The model reads the repository. Text in the repository can instruct it. A
malicious `README` or issue body can make it try things — which is exactly why
gitgate's boundary is *not* the prompt: whatever the model tries, only the
audited write set in allowed paths gets published. But injection can still
steer *content* (see 2) and can make the model exfiltrate anything it can read
(see 1) via any network access it has.

*Mitigation:* disable the engine's network (Codex: `sandbox_workspace_write.network_access=false`;
Claude Code: no `WebFetch`/`Bash` in the tool allowlist) unless the job needs
it. Treat "the model needs network" as a policy decision per job.

### 4. A hostile or compromised engine binary

gitgate trusts the command you configured to be the tool you meant. A malicious
`codex` on `PATH` is a malicious process running as your user (see 1). gitgate
runs it with `PATH` inherited from its own environment.

*Mitigation:* configure absolute paths in `engine.command`; keep `PATH` for the
gitgate service minimal.

### 5. Concurrency against the same branch

Two gitgate runs (or a gitgate run and a human) pushing to the same branch is
handled: the loser rebases, or parks on conflict. What is *not* protected is
semantic conflict — two non-overlapping edits that are individually valid and
jointly wrong. That is a review problem, not a Git one.

### 6. The remote itself

gitgate verifies with `fetch` + `merge-base --is-ancestor` and `ls-remote`. If
the remote lies (or an attacker controls it), so does the verification.
Protected-branch rules, required reviews and signed commits on the remote are
your friends and are outside gitgate's scope. Note gitgate disables commit
signing in the disposable clone (`commit.gpgsign=false`); if you require signed
commits, publish to a branch and let a signing step promote it.

### 7. Availability

A model that hangs is killed at the deadline. A remote that refuses pushes
produces `queued` runs until `queued_run_cap`, after which write runs are
refused (`failed`, "writes paused") until a human clears them. This is a
deliberate fail-closed: the alternative is silently accumulating unpublished
work. Monitor for it.

## Assumptions

- Node ≥ 22 and git ≥ 2.30, on POSIX. Process-group killing uses `kill(-pid)`.
- The runs directory is on a filesystem where `rename` is atomic within it
  (moving `.git` in and out is a rename, not a copy).
- gitgate itself is trusted code. If you can modify gitgate or its config, you
  can bypass gitgate.

## Reporting

If you find a way for a model run through gitgate to get something onto the
branch that the policy should have stopped, or to make gitgate report an
outcome that isn't true, please open an issue with a failing test against
`test/fixtures/fake-engine.mjs`. That is the most useful contribution this
project can receive.
