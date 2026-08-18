# gitgate

**The model proposes, git decides.**

gitgate runs any AI coding agent — Codex CLI, Claude Code, aider, your own loop —
inside a disposable clone that contains **no trusted Git metadata**, then has
trusted code (not the model) audit what changed against a small declarative
policy, commit exactly the approved paths, push, and **verify the push landed
before reporting anything**.

```
   your prompt / a systemd timer / a Slack bot / CI
                        │
                        ▼
   ┌───────────────────────────────────────────────┐
   │  fresh clone == remote branch tip             │
   │  trusted .git moved OUT of the tree           │
   │                                               │
   │      ┌─────────────────────────────┐          │
   │      │  engine = any command       │  ← the model may read and change files.
   │      │  sanitised env, own pgroup, │    It cannot commit, push, install hooks,
   │      │  hard deadline              │    or see the remote.
   │      └─────────────────────────────┘          │
   │                                               │
   │  restore trusted .git, quarantine model .git  │
   │  audit: git status → policy (paths, modes,    │
   │         deletions, symlinks, gitlinks)        │
   │  publish: stage exactly the approved paths,   │
   │           commit, push, PROVE — or park       │
   └───────────────────────────────────────────────┘
                        │
                        ▼
   one of nine truthful outcomes, as JSON and as an exit code
```

It is not an agent framework and it does not care which model you use. It is
the boundary between *change production* (the model's job) and *change
publication* (yours), packaged so you don't have to rediscover the failure modes
we did.

## Why this exists

If you wire an LLM to a repository and let it run unattended, these things
happen — not hypothetically; each one is a real incident this code was shaped by:

- The agent **reports success before the remote proves it**. A push fails
  three times and the summary still says "✅ landed".
- A **timeout becomes a later write**: the agent is killed, but a grandchild
  process (or a retry path) finishes the write after you stopped watching.
- The write set is derived from **the agent's own tool events**, so anything it
  did outside the tools you hooked — a shell `sed`, a `mv`, a `git commit` —
  never gets audited.
- The agent **commits, rebases, or force-pushes itself**, and now history is
  the model's opinion.
- **Ambiguous work is destroyed** to clear a queue: a push that might have
  landed, a conflict nobody looked at, a run that was interrupted mid-flight.
- Nobody thinks about **executable bits, symlinks, nested `.git` directories,
  gitlinks, or ignored files** until one of them ends up on `main`.

gitgate's whole job is to make each of those structurally impossible rather
than merely unlikely, and to say plainly what it does *not* protect against
(see [THREAT-MODEL.md](THREAT-MODEL.md)).

## Quick start

```sh
npm install -g gitgate        # Node ≥ 22 and git ≥ 2.30 on the box
```

Write a job file. The engine is just a command; `{prompt}`, `{prompt_file}`,
`{output_file}` and `{workspace}` are substituted, and the same values are
always exported as `GITGATE_PROMPT_FILE`, `GITGATE_OUTPUT_FILE`,
`GITGATE_WORKSPACE`, `GITGATE_JOB`, `GITGATE_MODE`.

```yaml
# docs-refresh.yml
name: docs-refresh
repo: git@github.com:example/handbook.git
branch: main
timeout: 10m

engine:
  command: [codex, exec, --ephemeral, --skip-git-repo-check,
            --sandbox, workspace-write, -C, "{workspace}",
            -c, 'approval_policy="never"',
            -o, "{output_file}", "{prompt}"]
  env: { CODEX_HOME: /var/lib/gitgate/codex-home }

policy:
  allow: [docs/**]
  deny:  [docs/legal/**]
  max_changed_files: 25

publish:
  commit_message: "docs: scheduled refresh"

prompt: |
  Fix stale statements, broken links and typos under docs/. Do not restructure.
  Reply with a two-line summary.
```

Rehearse it — everything runs for real except the push:

```sh
$ gitgate run docs-refresh.yml --dry-run
audited: audited 3 files: policy passed, publication skipped (dry run)
  docs/getting-started.md
  docs/install.md
  docs/toc.md

Fixed two dead links and a stale version number; regenerated the TOC.
```

Then run it for real, and read the exit code:

```sh
$ gitgate run docs-refresh.yml --json --quiet | jq .status
"pushed"
$ echo $?
0
```

More in [`examples/`](examples/): Codex, Claude Code, a no-model shell engine,
and systemd units.

## The contract

### Outcomes

Every run ends in exactly one of these. They are distinct facts, not severity
levels, and they appear identically in the JSON, the one-line summary, and the
exit code. None is reported until the remote has been checked.

| status      | exit | meaning |
|-------------|-----:|---------|
| `pushed`    | 0 | Audited changes are on the configured branch. **Verified** by fetching and proving the commit is an ancestor of the remote ref. |
| `clean`     | 0 | Write run finished; the engine changed nothing to publish. |
| `audited`   | 0 | `--dry-run`: changes passed policy; publication deliberately skipped. |
| `replied`   | 0 | Read-only run finished. Anything the engine wrote was discarded with the clone (and is listed). |
| `parked`    | 2 | The remote moved and the rebase conflicted. The work is pushed to `<park_prefix>/<stamp>` and **verified there** before you hear about it. Never auto-resolved. |
| `queued`    | 2 | Publication failed or is ambiguous (remote refused, network died mid-push). The run directory — restored `.git`, commit and all — is **retained** and never auto-retried. New write runs are refused once `queued_run_cap` such runs are waiting. |
| `rejected`  | 3 | The write set violated policy. Nothing was staged. |
| `timed_out` | 4 | The engine's whole process group was SIGKILLed at the deadline. Nothing was audited or published. |
| `failed`    | 1 | Engine non-zero exit, runaway output, or an infrastructure error. Nothing published. |

`gitgate runs list` shows what is retained; `gitgate runs clear <id|all>`
removes it once a human has looked. `--keep` retains any non-published run for
inspection (logs, prompt, reply, outcome, the restored checkout).

### Write-run invariants

This list is the product. The CLI and the engine plumbing exist to make it usable.

1. **Fresh base.** Every write run starts from a fresh clone proven equal to the
   remote branch tip — never a long-lived working copy, never local-only commits.
2. **Trusted metadata is out of reach.** `.git` is moved out of the checkout
   before the engine starts. The model can only change files.
3. **Bounded execution.** The engine runs with an allowlisted environment
   (nothing from gitgate's own env unless `pass_env` names it), a run-scoped
   `TMPDIR`, in its own process group, under a hard deadline that kills the
   whole group.
4. **Restore, then quarantine.** Trusted `.git` is restored even on failure;
   anything the model created that looks like Git state is moved aside, never
   honoured, and rejects the run.
5. **The write set comes from Git.** `git status` and `git ls-files` on the
   restored checkout — never from streamed tool events, never from what the
   model says it did.
6. **One violation rejects the whole run.** Paths outside the allow-list, deny
   matches, deletions (unless allowed), executables (unless allowed), symlinks,
   non-regular files, changed tracked modes, gitlinks, ignored files (unless
   discarded), too many files.
7. **Trusted code publishes.** Stage exactly the approved paths (never `add -A`),
   commit, fetch, push, fetch again, and **prove** the commit is an ancestor of
   the remote before saying `pushed`. On a rebase conflict, push to a park
   branch, prove it is there, and stop.
8. **Ambiguous work is preserved.** Retained runs are never destroyed to clear
   capacity and never retried automatically. A run interrupted by a crash or
   reboot is restored and queued on the next invocation — never audited or pushed.

The test suite (`npm test`) exercises each of these with a fake engine that
misbehaves on demand: allowed change, denied path, deletion, executable bit,
symlink, nested `.git`, model `git init`, ignored file, timeout with an escaping
grandchild, engine failure, runaway output, non-conflicting race, conflict →
park, refused push → queued + cap, interrupted-run recovery, env sanitisation.
If you swap in your own engine and it still passes, the boundary holds.

## Job file reference

```yaml
name: string                # [A-Za-z0-9._-], used in run markers and messages
repo: string                # anything `git clone` accepts. A LOCAL NON-BARE CLONE publishes to *its* origin
branch: main                # publish target; fetched fresh every run
mode: write | read-only     # read-only: engine runs in a clone too; its writes are discarded and listed
timeout: 10m                # 250ms | 90s | 5m | 1h  — kills the engine's whole process group

engine:
  command: [..] | "sh string"   # array runs directly; string runs via /bin/sh -c with placeholders quoted
  env: {K: V}                   # literal extra environment
  pass_env: [NAME, ...]         # copied from gitgate's own environment (API keys)
  home: /path                   # engine HOME (default: current user's). Read THREAT-MODEL.md.

policy:                     # required for write jobs
  allow: [globs]            # required, non-empty. `docs/` == `docs/**`. `*.md` is top-level only; use `**/*.md`
  deny: [globs]             # always wins over allow
  deny_create: [globs]      # may be edited but not created (paths another process owns the creation of)
  allow_deletions: false    # renames are delete+add, so this governs them too
  allow_executable: false   # any exec bit, or tracked mode 100755
  ignored_files: reject     # | discard  — what to do when the model writes a git-ignored path
  max_changed_files: 25

publish:
  commit_message: "..."     # default "<name>: automated update"
  park_prefix: gitgate/parked
  retries: 3                # fetch → push → verify → rebase cycles before `queued`
  author_name: gitgate
  author_email: gitgate@localhost

runs_dir: path              # default $XDG_STATE_HOME/gitgate/runs (~/.local/state/gitgate/runs)
queued_run_cap: 5           # refuse new write runs while this many retained runs await a human
prompt: |                   # default prompt; `--prompt` / `--prompt-file` override
```

`gitgate check job.yml` prints the fully-resolved config or the validation errors.

## Using it from code

```ts
import { loadJobFile, runJob } from "gitgate";

const outcome = await runJob(loadJobFile("docs-refresh.yml"), { prompt, dryRun: false });
if (outcome.status === "pushed") console.log(outcome.sha, outcome.changedPaths);
```

`runJob` never throws for engine or Git behaviour — switch on `outcome.status`.
The lower layers (`createRunsManager`, `auditWorkspace`, `publish`, `runEngine`)
are exported too if you want to compose them differently.

## Scheduling and monitoring

Use whatever fires commands on your box; [`examples/systemd/`](examples/systemd/)
has a oneshot service + timer. Two things learned the hard way:

- **Health is the outcome, not the process.** Alert on the JSON `status`, not on
  "the timer ran". `parked`/`queued` are exit 2 on purpose so a timer keeps
  firing while a human is paged.
- **Check that expected work actually landed** — a job that silently produces
  nothing looks identical to a healthy one from the process log. A tiny canary
  that inspects the remote branch for the job's expected commit is worth more
  than any amount of stdout.

## What gitgate does *not* do

Read [THREAT-MODEL.md](THREAT-MODEL.md) before trusting this with anything.
The short version: gitgate protects **the repository surface** — what can reach
the branch, in which paths, in which shapes. It does not stop a model from
reading files its Unix user can read, from putting bad prose in an allowed
file, or from being prompt-injected by content in the repo. Those need a
dedicated user or container, review of what lands, and a policy narrow enough
that "allowed" is still safe.

Non-goals, on purpose: a universal LLM/agent SDK abstraction; model-owned
commits or pushes; automatic retry of ambiguous work; a multi-tenant service;
bundled Slack/Calendar/etc. connectors (drive gitgate from them instead).

## Origins and status

Extracted from [Kubrick](https://github.com/tarikh/kubrick-x0000), a
self-hosted Slack chief-of-staff whose Claude/Codex engine switch needed a way
to let a second model runtime do real work without letting it own production
Git writes. The invariants above are the ones that survived contact with a
live system; the incidents in "Why this exists" are its incidents.

**Status: 0.1 — early.** The contract is stable in intent; option names may
still move. Kubrick is the first production consumer. Issues and PRs welcome,
especially failing tests that show a way through the boundary.

MIT.
