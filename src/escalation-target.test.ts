// What the EDIT-INTENT ESCALATION may send patch_with_tools for one target. patch_with_tools
// authors a missing file only when told is_new_file, and checks existence against the RUNTIME
// tree, which carries no tests. So the caller decides "new" from every place the file could
// already be — origin/dev in the push clone, the clone's working tree, the runtime tree — and
// an unknown is never "new": a test that exists on origin/dev must not be re-authored over.
// The scope fails CLOSED: with no readable copy, every target is refused (no target gets "edit").
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { decideEscalationTarget, type EscalationRoots } from "./escalation-target";

const tmp = mkdtempSync(join(tmpdir(), "esc-target-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function put(path: string, text = "x\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// A push clone whose origin/dev carries test/existing.test.ts, cloned from a bare origin.
const origin = join(tmp, "origin.git");
const seed = join(tmp, "seed");
const clones = join(tmp, "clones");
const runtime = join(tmp, "runtime");
mkdirSync(seed, { recursive: true });
git(seed, "init", "-q", "-b", "dev");
put(join(seed, "src/a.ts"));
put(join(seed, "test/existing.test.ts"));
git(seed, "add", "-A");
git(seed, "commit", "-qm", "seed");
git(tmp, "clone", "-q", "--bare", seed, origin);
mkdirSync(clones, { recursive: true });
git(clones, "clone", "-q", "-b", "dev", origin, "vessel-a");
rmSync(join(clones, "vessel-a/test/existing.test.ts")); // present on origin/dev, absent from the worktree
put(join(clones, "vessel-a/test/untracked.test.ts")); // in the worktree only
put(join(runtime, "vessel-a/src/a.ts"));
put(join(runtime, "vessel-a/src/runtime-only.ts"));

// A super-repo clone whose COMMITTED scope excludes a directory and one exact file.
const superRepo = join(tmp, "super");
mkdirSync(superRepo, { recursive: true });
git(superRepo, "init", "-q", "-b", "dev");
put(join(superRepo, "scripts/substrate/autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: ["repos/vessel-x/", "repos/vessel-a/src/judge.ts"] } }));
git(superRepo, "add", "-A");
git(superRepo, "commit", "-qm", "scope");

const roots: EscalationRoots = { clones, runtime, supers: [superRepo], imageScopeFile: join(tmp, "no-image-scope.json") };

describe("decideEscalationTarget", () => {
  it("MUST-FAIL: a target absent from origin/dev, the clone worktree and the runtime tree is a new file", () => {
    expect(decideEscalationTarget("repos/vessel-a/test/gap-new.test.ts", roots)).toEqual({ kind: "new_file" });
  });

  it("SAFETY: a file on origin/dev is never new, though the runtime tree and the worktree lack it", () => {
    expect(decideEscalationTarget("repos/vessel-a/test/existing.test.ts", roots).kind).toBe("edit");
  });

  it("SAFETY: a file only in the runtime tree, or only in the clone worktree, is never new", () => {
    expect(decideEscalationTarget("repos/vessel-a/src/runtime-only.ts", roots).kind).toBe("edit");
    expect(decideEscalationTarget("repos/vessel-a/test/untracked.test.ts", roots).kind).toBe("edit");
  });

  it("SAFETY: when origin/dev cannot be read (no clone), nothing is new", () => {
    expect(decideEscalationTarget("repos/vessel-missing/test/gap-new.test.ts", roots).kind).toBe("edit");
  });

  it("MUST-FAIL: a target under an excluded directory or equal to an excluded file is refused before escalation", () => {
    const d = decideEscalationTarget("repos/vessel-x/test/gap-new.test.ts", roots);
    expect(d.kind).toBe("refuse");
    expect(d.kind === "refuse" ? d.reason : "").toContain("repos/vessel-x/");
    expect(decideEscalationTarget("repos/vessel-a/src/judge.ts", roots).kind).toBe("refuse");
  });

  it("MUST-FAIL (fail closed): with every scope copy unreadable, no target is escalation-editable, and the refusal says why", () => {
    // Every way a copy can fail: no super configured, a super that is absent, one that is no git clone, one whose HEAD
    // names no excluded_paths, and an image copy that is absent or does not parse.
    const notGit = join(tmp, "not-a-clone");
    mkdirSync(notGit, { recursive: true });
    const empty = join(tmp, "super-empty");
    mkdirSync(empty, { recursive: true });
    git(empty, "init", "-q", "-b", "dev");
    put(join(empty, "scripts/substrate/autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: [] } }));
    git(empty, "add", "-A");
    git(empty, "commit", "-qm", "empty scope");
    const garbled = join(tmp, "garbled-image-scope.json");
    put(garbled, "{ not json");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const blinds: EscalationRoots[] = [
        { ...roots, supers: [], imageScopeFile: join(tmp, "absent.json") },
        { ...roots, supers: [join(tmp, "no-such-super"), notGit, empty], imageScopeFile: garbled },
      ];
      const targets = ["repos/vessel-x/test/gap-new.test.ts", "repos/vessel-a/test/gap-new.test.ts", "repos/vessel-a/src/a.ts", "repos/vessel-a/test/existing.test.ts", "docs/x.md", "repos/vessel-a/../escape.ts"];
      for (const blind of blinds) {
        for (const t of targets) {
          const d = decideEscalationTarget(t, blind);
          expect({ t, kind: d.kind }).toEqual({ t, kind: "refuse" });
          expect(d.kind === "refuse" ? d.reason : "").toContain("could not be read (fail closed)");
        }
      }
      const d = decideEscalationTarget("repos/vessel-a/src/a.ts", blinds[1]!);
      const reason = d.kind === "refuse" ? d.reason : "";
      for (const named of ["no-such-super: absent", "not-a-clone: HEAD:scripts/substrate/autonomy-scope.json unreadable", "super-empty: names no excluded_paths", "garbled-image-scope.json: "]) expect(reason).toContain(named);
      // The unparseable copy is logged where it is caught.
      expect(warn.mock.calls.some((c) => String(c[0]).includes("garbled-image-scope.json") && String(c[0]).includes("unreadable"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("CONTROL: a readable image copy (no super clone) decides exactly as the committed super copy does", () => {
    const image = join(tmp, "image-scope.json");
    put(image, JSON.stringify({ autonomyScope: { excluded_paths: ["repos/vessel-x/", "repos/vessel-a/src/judge.ts"] } }));
    const viaImage: EscalationRoots = { ...roots, supers: [], imageScopeFile: image };
    for (const t of ["repos/vessel-a/test/gap-new.test.ts", "repos/vessel-a/test/existing.test.ts", "repos/vessel-x/test/gap-new.test.ts", "repos/vessel-a/src/judge.ts", "repos/vessel-a/src/a.ts", "docs/x.md"]) {
      expect({ t, d: decideEscalationTarget(t, viaImage) }).toEqual({ t, d: decideEscalationTarget(t, roots) });
    }
  });

  it("CONTROL: an existing src file is an ordinary edit, and a path outside repos/<vessel>/ is left alone", () => {
    expect(decideEscalationTarget("repos/vessel-a/src/a.ts", roots)).toEqual({ kind: "edit" });
    expect(decideEscalationTarget("docs/x.md", roots)).toEqual({ kind: "edit" });
    expect(decideEscalationTarget("repos/vessel-a/../escape.ts", roots)).toEqual({ kind: "edit" });
  });
});

describe("the EDIT-INTENT ESCALATION uses the decision", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const start = src.indexOf("EDIT-INTENT ESCALATION SKIPPED for");
  const body = src.slice(start, src.indexOf("const pwtJson = await pwtResp.json()", start));

  it("decides before it calls patch_with_tools, and a refusal makes no call", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/const _escTarget = decideEscalationTarget\(String\(editFile\)\);/);
    expect(body).toMatch(/if \(_escTarget\.kind === "refuse"\) \{[\s\S]*?EDIT-INTENT ESCALATION REFUSED[\s\S]*?\} else try \{[\s\S]*?type: "patch_with_tools"/);
  });

  it("sends is_new_file only for a new_file decision", () => {
    expect(body).toContain(`...(_escTarget.kind === "new_file" ? { is_new_file: true } : {})`);
    expect(body.match(/is_new_file\s*:/g)?.length).toBe(1);
  });
});
