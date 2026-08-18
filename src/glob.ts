// Tiny glob → RegExp for repo-relative paths. Deliberately no dependency and
// deliberately explicit: `*.md` matches only at the top level, `**/*.md` matches
// anywhere, `docs/` is shorthand for `docs/**`. Allow-lists should be legible
// without consulting a gitignore manual.
//
//   **        any number of path segments (including none)
//   *         any run of characters within one segment
//   ?         one character within one segment
//   [abc]     character class (passed through)

export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (pattern.endsWith("/")) pattern += "**";
  if (!pattern) throw new Error("empty glob pattern");

  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" → zero or more segments; trailing "**" → anything.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        out += pattern.slice(i, close + 1);
        i = close;
      }
    } else if (/[.+^${}()|\\]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

export function matchesAny(path: string, globs: readonly string[]): string | undefined {
  for (const g of globs) if (globToRegExp(g).test(path)) return g;
  return undefined;
}
