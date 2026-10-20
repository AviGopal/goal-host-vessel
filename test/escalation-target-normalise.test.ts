// THE EDIT-INTENT ESCALATION NORMALISES ITS TARGET, THEN SCOPE-CHECKS EVERY TARGET.
//
// With a READABLE scope, decideEscalationTarget answered "edit" for a target with a `..` segment (so
// repos/<v>/src/x/../judge/<file> named an excluded file through an open prefix), answered "edit" for `.` and `//`
// segments without matching them, and never checked a target outside repos/<vessel>/ against the scope (so an
// excluded scripts/ path escaped the check). Pinned here:
//   - MUST-FAIL: a `..` target, an absolute target, and an excluded super-repo path are not "edit"; a `.`/`//` spelling
//     or a repos/-less spelling of an excluded file meets its entry;
//   - CONTROL: a plain lane-open target answers exactly as before (edit, new_file, or an entry refusal).
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { decideEscalationTarget, type EscalationRoots } from "../src/escalation-target";

const tmp = mkdtempSync(join(tmpdir(), "esc-normalise-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
function put(path: string, text = "x\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const FLOOR = "repos/goal-host-vessel/src/judge/floor-clamps.ts";
// A push clone of goal-host-vessel whose origin/dev carries src/a.ts and the floor module.
const seed = join(tmp, "seed");
mkdirSync(seed, { recursive: true });
git(seed, "init", "-q", "-b", "dev");
put(join(seed, "src/a.ts"));
put(join(seed, "src/judge/floor-clamps.ts"));
git(seed, "add", "-A");
git(seed, "commit", "-qm", "seed");
git(tmp, "clone", "-q", "--bare", seed, join(tmp, "origin.git"));
const clones = join(tmp, "clones");
mkdirSync(clones, { recursive: true });
git(clones, "clone", "-q", "-b", "dev", join(tmp, "origin.git"), "goal-host-vessel");

// A super-repo clone whose COMMITTED scope excludes one vessel file, one vessel directory and two super-repo paths.
const superRepo = join(tmp, "super");
mkdirSync(superRepo, { recursive: true });
git(superRepo, "init", "-q", "-b", "dev");
put(join(superRepo, "scripts/substrate/autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: [FLOOR, "repos/vessel-x/", "scripts/substrate/", "scripts/bootstrap-seeder.ts"] } }));
git(superRepo, "add", "-A");
git(superRepo, "commit", "-qm", "scope");
const roots: EscalationRoots = { clones, runtime: join(tmp, "runtime"), supers: [superRepo], imageScopeFile: join(tmp, "no-image.json") };
const kind = (t: string) => decideEscalationTarget(t, roots).kind;

describe("a target is normalised before the scope check (must-fail at the parent)", () => {
  it("a `..` target naming an excluded file through an open prefix is not 'edit'", () => {
    const d = decideEscalationTarget("repos/goal-host-vessel/src/x/../judge/floor-clamps.ts", roots);
    expect(d.kind).toBe("refuse");
    expect(d.kind === "refuse" ? d.reason : "").toContain("'..'");
  });
  it("any `..` target is refused, also one that resolves to an open file or leaves the repo", () => {
    for (const t of ["repos/goal-host-vessel/src/judge/../a.ts", "../outside.ts", "repos/../scripts/substrate/x.sh", "docs/../scripts/substrate/x.sh"]) {
      expect({ t, kind: kind(t) }).toEqual({ t, kind: "refuse" });
    }
  });
  it("an absolute target is refused", () => {
    for (const t of ["/workspace/git/super-repo/repos/goal-host-vessel/src/judge/floor-clamps.ts", "/vessels/goal-host-vessel/src/a.ts"]) {
      expect({ t, kind: kind(t) }).toEqual({ t, kind: "refuse" });
    }
  });
  it("`.` and `//` spellings and a repos/-less spelling of an excluded file meet its entry", () => {
    for (const t of ["repos/goal-host-vessel/./src/judge/floor-clamps.ts", "repos/goal-host-vessel//src/judge/floor-clamps.ts", "./././repos/goal-host-vessel/src/judge/floor-clamps.ts", "goal-host-vessel/src/judge/floor-clamps.ts"]) {
      const d = decideEscalationTarget(t, roots);
      expect({ t, d }).toEqual({ t, d: { kind: "refuse", reason: expect.stringContaining(`excluded autonomyScope entry ${FLOOR}`) as unknown as string } });
    }
  });
});

describe("every target is scope-checked, not only repos/<vessel>/ ones (must-fail at the parent)", () => {
  it("an excluded super-repo path is not 'edit'", () => {
    for (const [t, entry] of [["scripts/substrate/substrate-pull-sync.sh", "scripts/substrate/"], ["scripts/substrate/autonomy-scope.json", "scripts/substrate/"], ["scripts/bootstrap-seeder.ts", "scripts/bootstrap-seeder.ts"], ["./scripts/substrate/units/x.service", "scripts/substrate/"]] as const) {
      const d = decideEscalationTarget(t, roots);
      expect({ t, kind: d.kind }).toEqual({ t, kind: "refuse" });
      expect(d.kind === "refuse" ? d.reason : "").toContain(`entry ${entry}`);
    }
  });
});

describe("CONTROL: a plain target answers exactly as before", () => {
  it("lane-open repos targets: edit for a file origin/dev holds, new_file for one nowhere, refuse under an excluded entry", () => {
    expect(decideEscalationTarget("repos/goal-host-vessel/src/a.ts", roots)).toEqual({ kind: "edit" });
    expect(decideEscalationTarget("./repos/goal-host-vessel/src/a.ts", roots)).toEqual({ kind: "edit" });
    expect(decideEscalationTarget("repos/goal-host-vessel/test/gap-new.test.ts", roots)).toEqual({ kind: "new_file" });
    expect(decideEscalationTarget("repos/vessel-x/src/a.ts", roots)).toEqual({ kind: "refuse", reason: "repos/vessel-x/src/a.ts is under the excluded autonomyScope entry repos/vessel-x/" });
    expect(decideEscalationTarget(FLOOR, roots)).toEqual({ kind: "refuse", reason: `${FLOOR} is under the excluded autonomyScope entry ${FLOOR}` });
  });
  it("lane-open targets outside repos/ stay 'edit'", () => {
    for (const t of ["docs/x.md", "scripts/other.sh", "openspec/changes/x/tasks.md"]) expect({ t, d: decideEscalationTarget(t, roots) }).toEqual({ t, d: { kind: "edit" } });
  });
});
