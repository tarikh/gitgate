// The audit derives the write set from Git — `status` and `ls-files` on the
// restored checkout — never from anything the engine printed or claimed. Every
// changed path must be inside the checkout, not Git state, of a permitted kind
// (regular file; deletion only if allowed), of a permitted mode, and inside the
// job's allow-list minus its deny-list. One violation rejects the whole run:
// a partial publish of a rejected write set is exactly the ambiguity this tool
// exists to remove.
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { git, GitError, splitNul } from "./git.js";
import { matchesAny } from "./glob.js";
import type { Policy } from "./policy.js";

export class PolicyViolation extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export interface AuditResult {
  /** paths that passed and will be staged (deletions included) */
  approved: string[];
  /** ignored-file writes dropped under `ignored_files: discard` */
  discarded: string[];
}

export interface AuditTarget {
  checkout: string;
  base: string;
}

export async function auditWorkspace(ws: AuditTarget, policy: Policy): Promise<AuditResult> {
  const status = splitNul(await git(ws.checkout, "status", "--porcelain=v1", "-z", "-uall", "--no-renames"));
  const changes = new Map<string, string>();
  for (const entry of status) {
    if (entry.length < 4 || entry[2] !== " ") throw new PolicyViolation(`unparseable Git status entry: ${entry}`);
    changes.set(entry.slice(3), entry.slice(0, 2));
  }
  // A disposable clone has no legitimate untracked state, so an ignored
  // creation is still a model write and must be looked at.
  for (const path of splitNul(await git(ws.checkout, "ls-files", "--others", "-z"))) {
    if (!changes.has(path)) changes.set(path, "??");
  }

  const approved: string[] = [];
  const discarded: string[] = [];

  for (const [path, state] of changes) {
    if (path.includes("�")) throw new PolicyViolation("changed path is not valid UTF-8");
    const abs = resolve(ws.checkout, path);
    const rel = relative(ws.checkout, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new PolicyViolation(`changed path escapes the checkout: ${path}`, path);
    if (rel.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
      throw new PolicyViolation(`model-created Git state is forbidden: ${path}`, path);
    }

    const deleted = state.includes("D") || !existsSync(abs);
    if (deleted) {
      if (!policy.allow_deletions) throw new PolicyViolation(`deletion is not allowed by policy: ${path}`, path);
    } else if (state !== " M" && state !== "??") {
      // " T" (typechange), "AM" (should not occur: nothing is staged), etc.
      throw new PolicyViolation(`unsupported Git state ${JSON.stringify(state)} for ${path}`, path);
    }

    if (state === "??") {
      let ignored = false;
      try {
        await git(ws.checkout, "check-ignore", "-q", "--", path);
        ignored = true;
      } catch (err) {
        // exit 1 = not ignored. Any *other* failure rejects: an audit error can
        // never become permission to write.
        if (!(err instanceof GitError) || err.code !== 1) throw err;
      }
      if (ignored) {
        if (policy.ignored_files === "discard") {
          discarded.push(path);
          continue;
        }
        throw new PolicyViolation(`ignored file written (policy.ignored_files: reject): ${path}`, path);
      }
    }

    // Path policy applies to deletions too: you may not delete outside your allow-list.
    const denied = matchesAny(path, policy.deny);
    if (denied) throw new PolicyViolation(`path matches deny pattern "${denied}": ${path}`, path);
    if (!matchesAny(path, policy.allow)) throw new PolicyViolation(`path is outside the allow-list: ${path}`, path);
    if (state === "??") {
      const noCreate = matchesAny(path, policy.deny_create);
      if (noCreate) throw new PolicyViolation(`creating files matching deny_create pattern "${noCreate}" is not allowed: ${path}`, path);
    }

    if (!deleted) {
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) throw new PolicyViolation(`symlinks are forbidden: ${path}`, path);
      if (!info.isFile()) throw new PolicyViolation(`only regular files may be written: ${path}`, path);
      if (info.mode & 0o111 && !policy.allow_executable) {
        throw new PolicyViolation(`executable files are not allowed by policy: ${path}`, path);
      }
      const tree = await git(ws.checkout, "ls-tree", "-z", ws.base, "--", path);
      if (tree) {
        const baseMode = tree.split(/\s+/, 1)[0];
        const okModes = policy.allow_executable ? ["100644", "100755"] : ["100644"];
        if (!okModes.includes(baseMode ?? "")) {
          // 120000 symlink, 160000 gitlink, anything odd: never rewrite these
          throw new PolicyViolation(`tracked mode ${baseMode} may not be changed: ${path}`, path);
        }
      }
    }
    approved.push(path);
  }

  if (policy.max_changed_files !== undefined && approved.length > policy.max_changed_files) {
    throw new PolicyViolation(`${approved.length} changed paths exceeds max_changed_files=${policy.max_changed_files}`);
  }
  return { approved: approved.sort(), discarded: discarded.sort() };
}
