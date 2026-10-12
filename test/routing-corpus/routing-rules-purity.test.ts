// PROTECTED: the open routing rules (src/routing-rules/) are pure, reached by one edge, and clamped (DESIGN §2.2-§2.3).
//   PURITY  no I/O, clock, randomness, environment or replay-detection in src/routing-rules/**: no process, globalThis,
//           Bun, Date, Math.random, performance, fetch, require, eval, Function, import.meta, dynamic import(),
//           .stack, any __*ForTests, and no top-level statement with effects. Value imports only from other
//           src/routing-rules files and the allowlisted pure goal-text helpers; type imports from anywhere.
//   EDGE    the only src file that imports src/routing-rules/ is src/routing-core/entries.ts, taking exactly
//           decideDoor and decideHandoff; the floor imports no rules.
//   CLAMP   an answer with an extra key, a non-boolean, a goal the input did not offer, a target the goal does not name,
//           or an unknown route is refused, and the floor answers instead.
// Every checker is shown red on a synthetic mutant (a checker that cannot fail is not a check).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { clampDoor, clampHandoff } from "../../src/routing-core/entries";
import { floorDoor, floorHandoff } from "../../src/routing-core/floor";

const ROOT = join(import.meta.dir, "..", "..");
const RULES_DIR = "src/routing-rules";
const ALLOWED_VALUE_IMPORTS = new Set(["../goal-file-resolution", "../goal-intent"]);
const EDGE_FILE = "src/routing-core/entries.ts";
const EDGE_NAMES = ["decideDoor", "decideHandoff"];
const BANNED_IDS = new Set(["process", "globalThis", "Bun", "Date", "performance", "fetch", "require", "eval", "Function", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Worker", "WebAssembly", "XMLHttpRequest", "crypto"]);

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(e)) out.push(relative(ROOT, p)); } };
  walk(join(ROOT, dir));
  return out.sort();
}
const sf = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, v: (n: ts.Node) => void): void { v(n); n.forEachChild((c) => walk(c, v)); }

/** Purity offences in one rules file's text. */
export function purityOffences(name: string, text: string): string[] {
  const bad: string[] = [];
  const src = sf(name, text);
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const typeOnly = !!st.importClause?.isTypeOnly || (!!st.importClause && !st.importClause.name && !!st.importClause.namedBindings && ts.isNamedImports(st.importClause.namedBindings) && st.importClause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!st.importClause) bad.push(`side-effect import ${spec}`);
      else if (!typeOnly && !ALLOWED_VALUE_IMPORTS.has(spec) && !spec.startsWith("./")) bad.push(`value import ${spec}`);
      continue;
    }
    if (ts.isExportDeclaration(st)) { if (st.moduleSpecifier && !st.isTypeOnly && !(st.moduleSpecifier as ts.StringLiteral).text.startsWith("./")) bad.push("re-export from outside the rules"); continue; }
    if (ts.isFunctionDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const i = d.initializer;
        const ok = !i || ts.isRegularExpressionLiteral(i) || ts.isStringLiteral(i) || ts.isNumericLiteral(i) || ts.isNoSubstitutionTemplateLiteral(i) || ts.isArrowFunction(i) || ts.isFunctionExpression(i) || ts.isArrayLiteralExpression(i) || ts.isObjectLiteralExpression(i) || i.kind === ts.SyntaxKind.TrueKeyword || i.kind === ts.SyntaxKind.FalseKeyword || i.kind === ts.SyntaxKind.NullKeyword || (ts.isAsExpression(i) && (ts.isArrayLiteralExpression(i.expression) || ts.isObjectLiteralExpression(i.expression)));
        if (!ok) bad.push(`top-level initializer with possible effects (${ts.SyntaxKind[i!.kind]})`);
      }
      continue;
    }
    bad.push(`top-level statement ${ts.SyntaxKind[st.kind]}`);
  }
  bad.push(...effectOffences(src));
  return bad;
}

/** Effects anywhere in a file: banned globals, Math.random, .stack, import.meta, dynamic import(), __*ForTests. */
function effectOffences(src: ts.SourceFile): string[] {
  const bad: string[] = [];
  walk(src, (n) => {
    if (ts.isIdentifier(n) && BANNED_IDS.has(n.text)) {
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isPropertySignature(p) || (ts.isMethodDeclaration(p) && p.name === n);
      if (!isPropName) bad.push(`uses ${n.text}`);
    }
    if (ts.isIdentifier(n) && /^__\w*ForTests$/.test(n.text)) bad.push(`uses ${n.text}`);
    if (ts.isPropertyAccessExpression(n) && n.name.text === "random" && ts.isIdentifier(n.expression) && n.expression.text === "Math") bad.push("uses Math.random");
    if (ts.isPropertyAccessExpression(n) && n.name.text === "stack") bad.push("reads .stack");
    if (ts.isMetaProperty(n)) bad.push("uses import.meta");
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) bad.push("dynamic import()");
    if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && BANNED_IDS.has(n.expression.text)) bad.push(`indexes ${n.expression.text}`);
  });
  return bad;
}

/** The allowlisted helpers' own imports: a helper the rules may call must itself import nothing but allowlisted helpers. */
export function helperOffences(name: string, text: string): string[] {
  const bad: string[] = [];
  const src = sf(name, text);
  for (const st of src.statements) {
    if (!ts.isImportDeclaration(st) && !(ts.isExportDeclaration(st) && st.moduleSpecifier)) continue;
    const spec = ((st as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text;
    const clause = ts.isImportDeclaration(st) ? st.importClause : undefined;
    const typeOnly = ts.isImportDeclaration(st) ? !!clause?.isTypeOnly : !!(st as ts.ExportDeclaration).isTypeOnly;
    if (!typeOnly && !ALLOWED_VALUE_IMPORTS.has(spec.replace(/^\.\//, "../"))) bad.push(`helper value import ${spec}`);
  }
  bad.push(...effectOffences(src));
  return bad;
}

/** Value imports of src/routing-rules/ across src/, as `file: names`. */
export function ruleEdges(sources: Array<[string, string]>): string[] {
  const out: string[] = [];
  for (const [name, text] of sources) {
    if (name.startsWith(`${RULES_DIR}/`)) continue;
    if (!text.includes("routing-rules")) continue; // no specifier can name the rules without the directory name
    walk(sf(name, text), (n) => {
      if (ts.isImportDeclaration(n) && /routing-rules/.test((n.moduleSpecifier as ts.StringLiteral).text)) {
        const c = n.importClause;
        if (c?.isTypeOnly) return;
        const names = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : ["*"];
        if (c?.name) names.push("default");
        out.push(`${name}: ${names.sort().join(",")}`);
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && /routing-rules/.test((n.moduleSpecifier as ts.StringLiteral).text)) out.push(`${name}: re-export`);
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /routing-rules/.test(n.arguments[0].text)) out.push(`${name}: dynamic`);
    });
  }
  return out.sort();
}

const RULE_FILES = files(RULES_DIR);
const SRC = files("src").map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as [string, string]);

describe("PURITY: src/routing-rules/ does no I/O and cannot tell replay from production", () => {
  test("there is at least one rules file", () => { expect(RULE_FILES.length).toBeGreaterThan(0); });
  for (const f of RULE_FILES) test(`${f} is pure`, () => { expect(purityOffences(f, readFileSync(join(ROOT, f), "utf8"))).toEqual([]); });
  const ok = 'import type { DoorInput } from "../routing-core/types";\nimport { isPathlessCodeChangeGoal } from "../goal-file-resolution";\nconst R = /x/;\nexport function f(i: DoorInput): boolean { return R.test(i.goal) && isPathlessCodeChangeGoal(i.goal); }\n';
  test("positive control: an allowlisted helper and a type import are pure", () => { expect(purityOffences("ok.ts", ok)).toEqual([]); });
  const mutants: Array<[string, string]> = [
    ["process.env", 'export function f(): boolean { return process.env.X === "1"; }\n'],
    ["globalThis flag", "export function f(): boolean { return (globalThis as any).__replay === true; }\n"],
    ["Date.now", "export function f(): number { return Date.now(); }\n"],
    ["Math.random", "export function f(): number { return Math.random(); }\n"],
    ["stack", "export function f(): string { return new Error().stack ?? ''; }\n"],
    ["fetch", "export async function f(): Promise<unknown> { return fetch('http://x'); }\n"],
    ["node:fs value import", 'import { readFileSync } from "node:fs";\nexport function f(): string { return readFileSync("/x", "utf8"); }\n'],
    ["core value import", 'import { routingFellBack } from "../routing-core/entries";\nexport function f(): number { return routingFellBack.door; }\n'],
    ["dynamic import", 'export async function f(): Promise<unknown> { return import("node:fs"); }\n'],
    ["import.meta", "export function f(): string { return import.meta.dir; }\n"],
    ["top-level call", "const T = Symbol.for('x');\nexport function f(): symbol { return T; }\n"],
    ["Bun", "export function f(): string { return Bun.version; }\n"],
  ];
  for (const [label, text] of mutants) test(`MUTANT ${label} is red`, () => { expect(purityOffences("m.ts", text).length).toBeGreaterThan(0); });
  // The allowlisted helpers are lane-open goal-text classifiers: a lane edit that gave one an import or an effect would
  // make the rules impure transitively, so each helper is held to the same rule as an import.
  for (const spec of ALLOWED_VALUE_IMPORTS) {
    const f = `src/${spec.replace(/^\.\.\//, "")}.ts`;
    test(`allowlisted helper ${f} imports only allowlisted helpers and has no effect`, () => { expect(helperOffences(f, readFileSync(join(ROOT, f), "utf8"))).toEqual([]); });
  }
  test("MUTANT a helper importing node:fs is red", () => {
    expect(helperOffences("h.ts", 'import { readFileSync } from "node:fs";\nexport function g(): string { return readFileSync("/x", "utf8"); }\n').length).toBeGreaterThan(0);
  });
  test("MUTANT a helper reading the environment is red", () => {
    expect(helperOffences("h.ts", 'export function g(): boolean { return process.env.X === "1"; }\n').length).toBeGreaterThan(0);
  });
  test("positive control: a helper importing another allowlisted helper is clean", () => {
    expect(helperOffences("h.ts", 'import { isPathlessCodeChangeGoal } from "./goal-file-resolution";\nexport function g(s: string): boolean { return isPathlessCodeChangeGoal(s); }\n')).toEqual([]);
  });
});

describe("EDGE: only the core imports the rules, taking exactly the two decisions", () => {
  test(`the only edge is ${EDGE_FILE}: ${EDGE_NAMES.join(",")}`, () => {
    expect(ruleEdges(SRC)).toEqual([`${EDGE_FILE}: ${[...EDGE_NAMES].sort().join(",")}`]);
  });
  test("MUTANT a second importer (index.ts calling the rules directly, off the clamp) is red", () => {
    const m = SRC.map(([f, t]) => [f, f === "src/index.ts" ? `${t}\nimport { decideHandoff } from "./routing-rules/edit-intent";\n` : t] as [string, string]);
    expect(ruleEdges(m)).not.toEqual([`${EDGE_FILE}: ${[...EDGE_NAMES].sort().join(",")}`]);
  });
  test("MUTANT the core taking a third name is red", () => {
    const m = SRC.map(([f, t]) => [f, f === EDGE_FILE ? t.replace("import { decideDoor, decideHandoff } from", "import { decideDoor, decideHandoff, VERSION } from") : t] as [string, string]);
    expect(ruleEdges(m)).not.toEqual([`${EDGE_FILE}: ${[...EDGE_NAMES].sort().join(",")}`]);
  });
});

describe("CLAMP: an out-of-schema answer is refused and the floor answers", () => {
  const door = { goal: "g", restated_goal: "Edit repos/v/src/x.ts to satisfy the following request.\n\ng", chosen_file: "repos/v/src/x.ts", localization: null };
  test("positive controls: the floor's own answers pass the clamp", () => {
    expect(clampDoor(door, floorDoor(door))).toEqual(floorDoor(door));
    expect(clampDoor(door, { goal: "g", target: null, needs_localization: true })).toEqual({ goal: "g", target: null, needs_localization: true });
    const h = { goal_for_routing: "Fix repos/v/src/x.ts now", route_enabled: true };
    expect(clampHandoff(h, floorHandoff(h))).toEqual({ route: "feature_compose", target: "repos/v/src/x.ts" });
  });
  const badDoor: Array<[string, unknown]> = [
    ["extra key", { ...floorDoor(door), deterministic: true }],
    ["non-boolean", { goal: "g", target: null, needs_localization: "no" }],
    ["a goal the input did not offer", { goal: "Edit repos/v/src/index.ts to satisfy the following request.\n\ng", target: "repos/v/src/index.ts", needs_localization: false }],
    ["the restatement with another target", { goal: door.restated_goal, target: "repos/v/src/y.ts", needs_localization: false }],
    ["the restatement while asking for localization", { goal: door.restated_goal, target: door.chosen_file, needs_localization: true }],
    ["not an object", "feature_compose"],
  ];
  for (const [label, out] of badDoor) test(`door MUTANT ${label} is refused`, () => { expect(clampDoor(door, out)).toBeNull(); });
  const h = { goal_for_routing: "Fix repos/v/src/x.ts now", route_enabled: true };
  const badHandoff: Array<[string, unknown, typeof h]> = [
    ["unknown route", { route: "patch_with_tools", target: "repos/v/src/x.ts" }, h],
    ["a target the goal does not name", { route: "feature_compose", target: "repos/v/src/index.ts" }, h],
    ["a compose while the route is disabled", { route: "feature_compose", target: "repos/v/src/x.ts" }, { ...h, route_enabled: false }],
    ["walk with a target", { route: "walk", target: "repos/v/src/x.ts" }, h],
    ["extra key", { route: "walk", target: null, why: "x" }, h],
    ["a non-file target", { route: "feature_compose", target: "repos/v" }, { ...h, goal_for_routing: "Fix repos/v now" }],
  ];
  for (const [label, out, inp] of badHandoff) test(`hand-off MUTANT ${label} is refused`, () => { expect(clampHandoff(inp, out)).toBeNull(); });
});
