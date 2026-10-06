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
 * a super-repo clone, then the image copy. An unreadable scope refuses nothing, and makes
 * nothing new either: the escalation then behaves as it did before this module.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SCOPE_REL = "scripts/substrate/autonomy-scope.json";
export const IMAGE_SCOPE_FILE = "/usr/local/share/substrate/super-repo/scripts/substrate/autonomy-scope.json";

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

function excludedFrom(text: string): string[] | null {
  const body = (JSON.parse(text) as { autonomyScope?: { excluded_paths?: unknown; unrestricted?: unknown } })?.autonomyScope ?? {};
  const raw = Array.isArray(body.excluded_paths) ? body.excluded_paths : [];
  const excluded = raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim().replace(/^\.\//, ""));
  return excluded.length > 0 || body.unrestricted === true ? excluded : null;
}

/** The committed excluded paths, or null when no copy can be read. */
export function readExcludedPaths(supers: readonly string[], imageFile: string): string[] | null {
  for (const s of supers) {
    if (!existsSync(s)) continue;
    const r = git(s, ["show", `HEAD:${SCOPE_REL}`]);
    if (!r.ok) continue;
    try { const e = excludedFrom(r.out); if (e) return e; } catch { /* next copy */ }
  }
  try { return excludedFrom(readFileSync(imageFile, "utf8")); } catch { return null; }
}

/** The excluded entry a repo-relative path falls under (`dir/` entries match the tree), or null. */
export function scopeEntryFor(rel: string, excluded: readonly string[]): string | null {
  for (const e of excluded) {
    if (e.endsWith("/")) { if (rel === e.slice(0, -1) || rel.startsWith(e)) return e; }
    else if (rel === e) return e;
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
  const m = /^repos\/([\w.-]+)\/(.+)$/.exec(editFile.replace(/^\.\//, ""));
  if (!m || m[1] === "." || m[1] === ".." || m[2]!.split("/").some((p) => p === ".." || p === "." || p === "")) return { kind: "edit" };
  const [, vessel, rel] = m as unknown as [string, string, string];

  const excluded = readExcludedPaths(roots.supers, roots.imageScopeFile);
  if (excluded === null) return { kind: "edit" };
  const entry = scopeEntryFor(`repos/${vessel}/${rel}`, excluded);
  if (entry) return { kind: "refuse", reason: `repos/${vessel}/${rel} is under the excluded autonomyScope entry ${entry}` };

  const clone = join(roots.clones, vessel);
  if (onOriginDev(clone, rel) !== "absent") return { kind: "edit" };
  if (existsSync(join(clone, rel)) || existsSync(join(roots.runtime, vessel, rel))) return { kind: "edit" };
  return { kind: "new_file" };
}
