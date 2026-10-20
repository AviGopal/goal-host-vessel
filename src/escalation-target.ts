/**
 * WHAT THE EDIT-INTENT ESCALATION MAY SEND patch_with_tools FOR ONE TARGET.
 *
 * patch_with_tools authors a file that does not exist only when the pointer says
 * is_new_file: true; otherwise a target with no live source is "live source missing". The
 * escalation never said it, so every goal asking for a NEW file (each bootstrap-item-2
 * test-writing goal) got one feature_compose draft and no repair route.
 *
 * patch_with_tools judges existence against the RUNTIME tree, and no runtime tree carries
 * tests. A test that exists on origin/dev therefore looks absent there, and is_new_file would
 * author over it. So "new" is decided here, from every place the file could already be:
 * origin/dev in the push clone, the clone's working tree, and the runtime tree. Anything this
 * cannot read is NOT new. patch_with_tools still refuses is_new_file on a target it can see.
 *
 * A target under an excluded autonomyScope path is refused before any patch_with_tools call
 * (the lane cannot land it, so the escalation would only spend attempts). The scope is the
 * COMMITTED one, read the way @avigopal/write-containment's readCommittedScope reads it: HEAD of
 * a super-repo clone, then the image copy. An unreadable scope REFUSES EVERY TARGET (fail closed,
 * as every other scope reader does): a scope copy that is missing, unparseable or names nothing
 * must not make the excluded core escalation-editable. The refusal names why each copy failed.
 *
 * EVERY TARGET IS NORMALISED, THEN SCOPE-CHECKED. A target with a `..` segment is refused (it could name an
 * excluded file through an open prefix, or leave the repo), and so is an absolute one; `./`, `//` and `.`
 * segments are collapsed. The scope check then runs on the normalised path for every target, not only
 * repos/<vessel>/ ones, so an excluded super-repo path (scripts/…) is refused too. A target outside repos/ is also
 * checked as repos/<target>, so a vessel path written without its repos/ prefix meets its entry.
 *
 * DIRECTORY EXCEPTIONS: the record's sibling field excluded_path_exceptions lists EXACT files a directory
 * entry does not exclude, with the semantics of development-vessel's autonomyScopeExcludes (gap-policy.ts):
 * excluded iff an exact entry matches, or a directory entry matches and the path is not an exception. An
 * exception counts only for an exact file under a directory entry (a directory, glob, `..` or bare basename
 * excepts nothing), an exact entry wins over an exception, and a file added under the directory later stays
 * excluded. scopeEntryFor is the one matcher for both goal-host readers: this escalation and the verdict
 * corpus runner's routeGap (judge/corpus-activity.ts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const SCOPE_REL = "scripts/substrate/autonomy-scope.json";
export const IMAGE_SCOPE_FILE = "/usr/local/share/substrate/super-repo/scripts/substrate/autonomy-scope.json";

/** The scope as a reader matches it: excluded_paths and the exact-file excluded_path_exceptions. */
export interface ScopePaths { excluded: string[]; exceptions: string[] }

export type EscalationTarget = { kind: "edit" } | { kind: "new_file" } | { kind: "refuse"; reason: string };

export interface EscalationRoots { clones: string; runtime: string; supers: string[]; imageScopeFile: string }

export function escalationRoots(env: Record<string, string | undefined> = process.env): EscalationRoots {
  const supers: string[] = [];
  for (const s of [env["SUPER_REPO_DIR"], env["MITOSIS_SUPER_REPO_DIR"], env["WORKSPACE_ROOT"], "/workspace/git/super-repo"]) {
    const t = (s ?? "").trim();
    if (t.startsWith("/") && !supers.includes(t)) supers.push(t);
  }
  return {
    clones: env["VESSELS_CLONE_ROOT"] ?? "/workspace/git/vessels",
    runtime: env["MITOSIS_RUNTIME_DIR"] ?? "/vessels",
    supers,
    imageScopeFile: IMAGE_SCOPE_FILE,
  };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000 });
  return { ok: r.status === 0, out: String(r.stdout ?? "") };
}

/** excluded_path_exceptions: exact file paths only; a directory (trailing `/`), a glob or a `..` segment is dropped. */
export function parseScopeExceptions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()) : [];
  return list.filter((e) => !e.endsWith("/") && !/[*?[\]{}!]/.test(e) && !e.split("/").includes(".."));
}

function scopeFrom(text: string): ScopePaths | null {
  const body = (JSON.parse(text) as { autonomyScope?: { excluded_paths?: unknown; unrestricted?: unknown; excluded_path_exceptions?: unknown } })?.autonomyScope ?? {};
  const raw = Array.isArray(body.excluded_paths) ? body.excluded_paths : [];
  const excluded = raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim().replace(/^\.\//, ""));
  return excluded.length > 0 || body.unrestricted === true ? { excluded, exceptions: parseScopeExceptions(body.excluded_path_exceptions) } : null;
}

/** The committed scope, or null when no copy can be read; `why` gets one reason per copy that could not be. */
export function readCommittedScopePaths(supers: readonly string[], imageFile: string, why: string[] = []): ScopePaths | null {
  for (const s of supers) {
    if (!existsSync(s)) { why.push(`${s}: absent`); continue; }
    const r = git(s, ["show", `HEAD:${SCOPE_REL}`]);
    if (!r.ok) { why.push(`${s}: HEAD:${SCOPE_REL} unreadable`); continue; }
    try {
      const e = scopeFrom(r.out);
      if (e) return e;
      why.push(`${s}: names no excluded_paths and is not unrestricted`);
    } catch (err) {
      why.push(`${s}: ${(err as Error)?.message ?? String(err)}`);
      console.warn(`[escalation-target] scope copy HEAD:${SCOPE_REL} in ${s} unreadable: ${(err as Error)?.message ?? String(err)}`);
    }
  }
  try {
    const e = scopeFrom(readFileSync(imageFile, "utf8"));
    if (!e) why.push(`${imageFile}: names no excluded_paths and is not unrestricted`);
    return e;
  } catch (err) {
    why.push(`${imageFile}: ${(err as Error)?.message ?? String(err)}`);
    console.warn(`[escalation-target] image scope copy ${imageFile} unreadable: ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

/** The excluded entry a repo-relative path falls under (`dir/` entries match the tree), or null. A directory entry
 *  skips a path its exceptions name exactly (an exception outside the directory counts for nothing); an exact entry
 *  never does, and the scan goes on past an excepted directory hit so a later exact entry is still found. */
export function scopeEntryFor(rel: string, excluded: readonly string[], exceptions: readonly string[] = []): string | null {
  const strip = (p: string) => p.replace(/^\.\//, "").replace(/^repos\//, "");
  const excepts = parseScopeExceptions(exceptions).map(strip);
  for (const e of excluded) {
    if (e.endsWith("/")) {
      if (rel === e.slice(0, -1) || rel.startsWith(e)) {
        const d = strip(e);
        if (excepts.some((x) => x.startsWith(d) && strip(rel) === x)) continue;
        return e;
      }
    } else if (rel === e) return e;
  }
  return null;
}

/** Whether origin/dev in the push clone holds the path; "unknown" when origin/dev cannot be read. */
function onOriginDev(clone: string, rel: string): "present" | "absent" | "unknown" {
  if (!existsSync(clone) || !git(clone, ["rev-parse", "--verify", "-q", "origin/dev^{commit}"]).ok) return "unknown";
  const r = git(clone, ["ls-tree", "--name-only", "origin/dev", "--", rel]);
  if (!r.ok) return "unknown";
  return r.out.trim() ? "present" : "absent";
}

export function decideEscalationTarget(editFile: string, roots: EscalationRoots = escalationRoots()): EscalationTarget {
  // FAIL CLOSED: with no readable scope copy, no target (inside repos/ or not) is escalation-editable.
  const why: string[] = [];
  const scope = readCommittedScopePaths(roots.supers, roots.imageScopeFile, why);
  if (scope === null) return { kind: "refuse", reason: `the committed autonomyScope could not be read (fail closed): ${why.join("; ") || "no scope copy configured"}` };

  // NORMALISED BEFORE THE SCOPE CHECK, which every target gets (repos/<vessel>/ or not).
  const raw = String(editFile).trim();
  if (raw.startsWith("/")) return { kind: "refuse", reason: `${raw} is an absolute path; an escalation target is repo-relative` };
  if (raw.split("/").includes("..")) return { kind: "refuse", reason: `${raw} has a '..' segment, which could name an excluded file through an open prefix or leave the repo` };
  const target = posix.normalize(raw).replace(/^(\.\/)+/, "");
  const entry = scopeEntryFor(target, scope.excluded, scope.exceptions)
    ?? (target.startsWith("repos/") ? null : scopeEntryFor(`repos/${target}`, scope.excluded, scope.exceptions));
  if (entry) return { kind: "refuse", reason: `${target} is under the excluded autonomyScope entry ${entry}` };

  const m = /^repos\/([\w.-]+)\/(.+)$/.exec(target);
  if (!m || m[1] === "." || m[2]!.split("/").some((p) => p === "." || p === "")) return { kind: "edit" };
  const [, vessel, rel] = m as unknown as [string, string, string];

  const clone = join(roots.clones, vessel);
  if (onOriginDev(clone, rel) !== "absent") return { kind: "edit" };
  if (existsSync(join(clone, rel)) || existsSync(join(roots.runtime, vessel, rel))) return { kind: "edit" };
  return { kind: "new_file" };
}
