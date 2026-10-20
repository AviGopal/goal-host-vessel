// A DIRECTORY ENTRY WITH EXACT-FILE EXCEPTIONS, read by BOTH goal-host scope readers.
//
// The autonomyScope record carries excluded_path_exceptions beside excluded_paths: exact files a directory entry does
// not exclude. development-vessel's lane matcher (autonomyScopeExcludes, src/judge/gap-policy.ts) defines the
// semantics; goal-host has two readers of the same record that read only excluded_paths, so a file the user lifted by
// exception still routed its corpus-verdict gaps to operator review and still had its escalation refused:
//   - the edit-intent escalation (src/escalation-target.ts, the COMMITTED scope copy);
//   - the verdict corpus runner's routeGap (src/judge/corpus-activity.ts, the LIVE pool record via index.ts).
// Both now match through the one scopeEntryFor. SHARED FIXTURES: the CASES table below is the case list of
// development-vessel test/resolvers/autonomy-scope-directory-exceptions.test.ts (same constants, same expected entry),
// and every case is driven through BOTH readers, so neither reader can drift from the other or from the lane:
//   - excluded iff an exact entry matches, OR a directory entry matches and the path is not an exception;
//   - an exception counts only for an exact file under a directory entry: a directory, glob, `..` or basename
//     exception is dropped, and one outside every directory changes nothing;
//   - an exact entry wins over an exception, whatever the entry order;
//   - a file added under the directory later stays excluded (forward-closed);
//   - CONTROL: with no exceptions field, matching is unchanged.
// The dv test's path-form cases (`./`, absolute, `:line`) are not carried: goal-host's readers never matched those
// forms for any entry, and matching them only for exceptions would widen.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as esc from "../src/escalation-target";
import * as corpus from "../src/judge/corpus-activity";
import type { EscalationRoots, ScopePaths } from "../src/escalation-target";

// Namespace reads so each case is judged on its own at a parent without the exceptions support. There the record
// reader falls back to what index.ts read before it (excluded_paths alone), so the parent's routing is what is judged.
const { decideEscalationTarget } = esc;
const { routeGap } = corpus;
const scopeEntryFor = esc.scopeEntryFor as (rel: string, excluded: readonly string[], exceptions?: readonly string[]) => string | null;
const parseScopeExceptions = (esc as Record<string, unknown>)["parseScopeExceptions"] as (raw: unknown) => string[];
const scopeFromRecordBody = ((corpus as Record<string, unknown>)["scopeFromRecordBody"]
  ?? ((b: { excluded_paths?: string[] } | null | undefined) => b?.excluded_paths ?? null)) as (body: unknown) => ScopePaths | null;

const DIR = "repos/goal-host-vessel/src/judge/";
const CREDIT = `${DIR}credit-decision.ts`;
const FLOOR = `${DIR}floor-clamps.ts`;
const NEW_FILE = `${DIR}a-module-added-after-the-lift.ts`;
const EXACT = "repos/development-vessel/src/judge/gap-policy.ts";
const OUTSIDE = "repos/boredom-vessel/src/index.ts";
const OUTSIDE_FILE = "repos/goal-host-vessel/src/other.ts";

/** One case: the scope record (excluded_paths + optional excluded_path_exceptions), a path, the entry that excludes it. */
type Case = { name: string; excluded: string[]; exceptions?: string[]; path: string; entry: string | null };
const CASES: Case[] = [
  // a directory entry with an exact-file exception (must-fail at the parent)
  { name: "the excepted file reads OPEN", excluded: [DIR, EXACT], exceptions: [CREDIT], path: CREDIT, entry: null },
  { name: "a sibling the exception does not name stays EXCLUDED", excluded: [DIR, EXACT], exceptions: [CREDIT], path: FLOOR, entry: DIR },
  { name: "a NEW file under the directory stays EXCLUDED (forward-closed)", excluded: [DIR, EXACT], exceptions: [CREDIT], path: NEW_FILE, entry: DIR },
  { name: "a same-named file in a subdirectory stays EXCLUDED", excluded: [DIR, EXACT], exceptions: [CREDIT], path: `${DIR}sub/credit-decision.ts`, entry: DIR },
  // an exception counts only for an exact file under a directory entry
  { name: "an exception under no directory entry changes nothing (open file)", excluded: [DIR, EXACT], exceptions: [OUTSIDE_FILE, EXACT, OUTSIDE], path: OUTSIDE_FILE, entry: null },
  { name: "an exception under no directory entry changes nothing (exact file)", excluded: [DIR, EXACT], exceptions: [OUTSIDE_FILE, EXACT, OUTSIDE], path: EXACT, entry: EXACT },
  { name: "an exception under no directory entry changes nothing (other vessel)", excluded: [DIR, EXACT], exceptions: [OUTSIDE_FILE, EXACT, OUTSIDE], path: OUTSIDE, entry: null },
  { name: "an exception naming an exact entry leaves it EXCLUDED", excluded: [DIR, EXACT], exceptions: [EXACT], path: EXACT, entry: EXACT },
  { name: "an exception that is ALSO an exact entry stays EXCLUDED (directory first)", excluded: [DIR, CREDIT], exceptions: [CREDIT], path: CREDIT, entry: CREDIT },
  { name: "an exception that is ALSO an exact entry stays EXCLUDED (exact first)", excluded: [CREDIT, DIR], exceptions: [CREDIT], path: CREDIT, entry: CREDIT },
  ...[DIR, `${DIR}*.ts`, `${DIR}credit-*`, "credit-decision.ts", "src/judge/credit-decision.ts", `${DIR}../judge/credit-decision.ts`].map((exc): Case => (
    { name: `a dropped exception (${exc}) excepts nothing`, excluded: [DIR], exceptions: [exc], path: CREDIT, entry: DIR })),
  { name: "a subdirectory exception excepts nothing", excluded: [DIR], exceptions: [`${DIR}sub/`], path: `${DIR}sub/x.ts`, entry: DIR },
  // the lane strips ./ and repos/ from entries and exceptions before comparing them, so these forms except too
  { name: "an exception written without repos/ excepts the file", excluded: [DIR], exceptions: [CREDIT.replace(/^repos\//, "")], path: CREDIT, entry: null },
  { name: "an exception written with ./ excepts the file", excluded: [DIR], exceptions: [`./${CREDIT}`], path: CREDIT, entry: null },
  // CONTROL: with no exceptions, prefix and exact entries behave as before
  { name: "CONTROL: no exceptions, the directory covers the file", excluded: [DIR, EXACT], path: CREDIT, entry: DIR },
  { name: "CONTROL: no exceptions, the directory covers its sibling", excluded: [DIR, EXACT], path: FLOOR, entry: DIR },
  { name: "CONTROL: no exceptions, an exact entry matches", excluded: [DIR, EXACT], path: EXACT, entry: EXACT },
  { name: "CONTROL: no exceptions, a path under no entry is open", excluded: [DIR, EXACT], path: OUTSIDE, entry: null },
  { name: "CONTROL: an empty exceptions list, the directory covers the file", excluded: [DIR, EXACT], exceptions: [], path: CREDIT, entry: DIR },
];

const tmp = mkdtempSync(join(tmpdir(), "scope-dir-exc-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
const record = (c: { excluded: string[]; exceptions?: string[] }) => ({ excluded_paths: c.excluded, ...(c.exceptions ? { excluded_path_exceptions: c.exceptions } : {}) });

/** READER 1, the edit-intent escalation: the case's record as the committed image copy (no vessel clone, so a target
 *  the scope leaves open resolves to "edit"). The excluding entry, or null when the target is not refused. */
let n = 0;
function escalationEntry(c: Case, supers: string[] = []): string | null {
  const image = join(tmp, `image-${n++}.json`);
  put(image, JSON.stringify({ autonomyScope: record(c) }));
  const roots: EscalationRoots = { clones: join(tmp, "no-clones"), runtime: join(tmp, "no-runtime"), supers, imageScopeFile: image };
  const d = decideEscalationTarget(c.path, roots);
  if (d.kind !== "refuse") return null;
  const m = / is under the excluded autonomyScope entry (.+)$/.exec(d.reason);
  if (!m) throw new Error(`refused for another reason: ${d.reason}`);
  return m[1]!;
}
/** READER 2, the corpus runner's routeGap, fed the live record the way index.ts reads it. */
function routeEntry(c: Case): string | null {
  const scope = scopeFromRecordBody(record(c));
  expect(scope).not.toBeNull();
  const r = routeGap(c.path, scope);
  expect(r.to === "lane").toBe(r.scope_entry === null);
  return r.scope_entry;
}

describe("SHARED FIXTURES: every lane case, through both goal-host readers", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect({ path: c.path, matcher: scopeEntryFor(c.path, c.excluded, c.exceptions) }).toEqual({ path: c.path, matcher: c.entry });
      expect({ path: c.path, escalation: escalationEntry(c) }).toEqual({ path: c.path, escalation: c.entry });
      expect({ path: c.path, routeGap: routeEntry(c) }).toEqual({ path: c.path, routeGap: c.entry });
    });
  }
});

describe("the falsifier: excluded_paths [src/judge/] + exception credit-decision.ts (must-fail at the parent)", () => {
  const scope = { excluded: [DIR], exceptions: [CREDIT] };
  it("both readers treat credit-decision.ts as lane-open; floor-clamps.ts and a new file stay closed", () => {
    expect(escalationEntry({ name: "", ...scope, path: CREDIT, entry: null })).toBeNull();
    expect(routeGap(CREDIT, scopeFromRecordBody(record(scope)))).toMatchObject({ to: "lane", scope_entry: null });
    for (const p of [FLOOR, NEW_FILE]) {
      expect(escalationEntry({ name: "", ...scope, path: p, entry: DIR })).toBe(DIR);
      expect(routeGap(p, scopeFromRecordBody(record(scope)))).toMatchObject({ to: "operator_review", scope_entry: DIR });
    }
  });
  it("the escalation reads the field from a super clone's COMMITTED HEAD copy too", () => {
    const sup = join(tmp, "super");
    mkdirSync(sup, { recursive: true });
    git(sup, "init", "-q", "-b", "dev");
    put(join(sup, "scripts/substrate/autonomy-scope.json"), JSON.stringify({ autonomyScope: record(scope) }));
    git(sup, "add", "-A");
    git(sup, "commit", "-qm", "scope");
    const roots: EscalationRoots = { clones: join(tmp, "no-clones"), runtime: join(tmp, "no-runtime"), supers: [sup], imageScopeFile: join(tmp, "absent.json") };
    expect(decideEscalationTarget(CREDIT, roots).kind).toBe("edit");
    expect(decideEscalationTarget(FLOOR, roots)).toMatchObject({ kind: "refuse" });
    expect(decideEscalationTarget(NEW_FILE, roots)).toMatchObject({ kind: "refuse" });
  });
  it("CONTROL: the same record without the field keeps credit-decision.ts closed in both readers", () => {
    expect(escalationEntry({ name: "", excluded: [DIR], path: CREDIT, entry: DIR })).toBe(DIR);
    expect(routeGap(CREDIT, scopeFromRecordBody(record({ excluded: [DIR] })))).toMatchObject({ to: "operator_review", scope_entry: DIR });
    expect(routeGap(CREDIT, [DIR])).toMatchObject({ to: "operator_review", scope_entry: DIR });
  });
});

describe("parsing excluded_path_exceptions", () => {
  it("a directory, glob or `..` exception is dropped; strings are trimmed; non-strings ignored", () => {
    expect(parseScopeExceptions).toBeInstanceOf(Function);
    expect(parseScopeExceptions([CREDIT, ` ${FLOOR} `, DIR, `${DIR}sub/`, `${DIR}*.ts`, `${DIR}credit-*`, `${DIR}../judge/floor-clamps.ts`, "", 7, null])).toEqual([CREDIT, FLOOR]);
    expect(parseScopeExceptions(undefined)).toEqual([]);
    expect(parseScopeExceptions(null)).toEqual([]);
  });
  it("the live record reader carries the parsed field, and keeps its strictness on excluded_paths", () => {
    expect(scopeFromRecordBody({ excluded_paths: [DIR, EXACT], excluded_path_exceptions: [CREDIT, `${DIR}*.ts`] })).toEqual({ excluded: [DIR, EXACT], exceptions: [CREDIT] });
    expect(scopeFromRecordBody({ excluded_paths: [DIR, EXACT] })).toEqual({ excluded: [DIR, EXACT], exceptions: [] });
    for (const bad of [undefined, null, {}, { excluded_paths: [] }, { excluded_paths: [DIR, 7] }, { excluded_paths: DIR }, { unrestricted: true }]) {
      expect(scopeFromRecordBody(bad)).toBeNull();
    }
  });
  it("an unreadable scope still closes the excepted file in both readers", () => {
    expect(routeGap(CREDIT, null).to).toBe("operator_review");
    const blind: EscalationRoots = { clones: join(tmp, "no-clones"), runtime: join(tmp, "no-runtime"), supers: [], imageScopeFile: join(tmp, "absent.json") };
    expect(decideEscalationTarget(CREDIT, blind).kind).toBe("refuse");
  });
});

describe("index.ts feeds routeGap the record through scopeFromRecordBody", () => {
  const src = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  const start = src.indexOf("async function readLiveScopeExcluded(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  it("readLiveScopeExcluded parses the live record with scopeFromRecordBody, not excluded_paths alone", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/return scopeFromRecordBody\(j\.body\?\.impulses\?\.\[0\]\?\.body\);/);
    expect(body).not.toMatch(/\.excluded_paths\b/);
  });
  it("both runner paths route with that read", () => {
    expect(src).toContain("readScopeExcluded: () => readLiveScopeExcluded(),");
    expect(src).toContain("route: routeGap(site, await readLiveScopeExcluded())");
  });
});
