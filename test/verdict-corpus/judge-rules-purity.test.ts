// PROTECTED (MUST-FAILS): THE OPEN JUDGE RULES ARE PURE, THEIR OUTPUT IS CLAMPED, AND ONE CLOSED SITE IMPORTS THEM.
//
// Purity (static, on the TypeScript AST, so comments and strings never count): every file under src/judge-rules/
//   - imports only type-only modules, other src/judge-rules/ files, and the pure helpers on ALLOWED_OUTSIDE;
//   - names none of FORBIDDEN_NAMES (no I/O, no clock, no randomness, no environment, no stack inspection), no
//     Math.random, no import.meta, no dynamic import(), no __*ForTests;
//   - has only declarations at top level (nothing runs when the module loads);
//   - re-exports nothing from outside src/judge-rules/ (a re-export could be swapped for a loosened copy).
// This is what stops an open rule from telling a corpus replay from production.
//
// Output-schema clamp: an adversarial rules module (extra key, non-boolean, unknown hollow class, forged reason
// code, a throw) is REFUSED, and the entry falls back closed (not reached / refused / rejected).
//
// The edge: the only src file that imports src/judge-rules/ is src/judge/entries.ts, by ONE dynamic import() of
// ../judge-rules/index that destructures exactly ENTRY_SYMBOLS; src/judge-rules/ imports nothing from src/judge/
// except types, and nothing from index.ts. The rules' import closure is pinned (the held-out guard's closure).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as judge from "../../src/judge/entries";
import { reachInput, shortcutInput, reframeInput, floorInput } from "../../src/judge/inputs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULES_DIR = "src/judge-rules/";
const CORE = "src/judge/entries.ts";
const ALLOWED_OUTSIDE = ["src/goal-intent.ts", "src/fs-write-shapes.ts", "src/resolve-pointer.ts"];
const FORBIDDEN_NAMES = new Set(["fetch", "Bun", "process", "globalThis", "global", "window", "self", "require", "eval", "Function", "console", "Date", "performance", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Worker", "WebAssembly", "XMLHttpRequest", "WebSocket", "Error", "Reflect", "Proxy", "crypto", "Atomics", "SharedArrayBuffer"]);
const ENTRY_SYMBOLS = ["floorDecide", "floorShortcutAllowed", "reachGate", "reframeAccept"];
/** The rules' import closure (pinned): a candidate touching any of these files touches the judge. */
export const JUDGE_RULES_IMPORT_CLOSURE = [
  "src/fs-write-shapes.ts",
  "src/goal-file-resolution.ts",
  "src/goal-intent.ts",
  "src/judge-rules/floor.ts",
  "src/judge-rules/index.ts",
  "src/judge-rules/reframe.ts",
  "src/judge-rules/write-goal.ts",
  "src/resolve-pointer.ts",
];

const sf = (name: string, text: string): ts.SourceFile => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(n: ts.Node, visit: (n: ts.Node) => void): void { visit(n); n.forEachChild((c) => walk(c, visit)); }
function listTs(dirRel: string, withTests = false): string[] {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const e of readdirSync(join(ROOT, d))) {
      const p = `${d}${e}`;
      if (statSync(join(ROOT, p)).isDirectory()) rec(`${p}/`);
      else if (/\.tsx?$/.test(e) && (withTests || !/\.test\.tsx?$/.test(e))) out.push(p);
    }
  };
  rec(dirRel);
  return out.sort();
}
function resolveSpec(fromRel: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  const base = join(ROOT, fromRel, "..", spec);
  for (const c of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    try { if (statSync(c).isFile()) return relative(ROOT, c); } catch { /* next */ }
  }
  return relative(ROOT, base.replace(/\.js$/, ".ts"));
}
const isTypeOnlyImport = (n: ts.ImportDeclaration): boolean => !!n.importClause && (n.importClause.isTypeOnly
  || (!n.importClause.name && !!n.importClause.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && n.importClause.namedBindings.elements.length > 0 && n.importClause.namedBindings.elements.every((e) => e.isTypeOnly)));

/** The purity offenders of one open rules file. */
export function purityOffenders(rel: string, text: string): string[] {
  const bad: string[] = [];
  const src = sf(rel, text);
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st)) {
      if (isTypeOnlyImport(st)) continue;
      const r = resolveSpec(rel, (st.moduleSpecifier as ts.StringLiteral).text);
      if (!(r.startsWith(RULES_DIR) || ALLOWED_OUTSIDE.includes(r))) bad.push(`import ${(st.moduleSpecifier as ts.StringLiteral).text}`);
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !resolveSpec(rel, st.moduleSpecifier.text).startsWith(RULES_DIR)) bad.push(`re-export from ${st.moduleSpecifier.text}`);
      continue;
    }
    const decl = ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st);
    if (!decl && !ts.isVariableStatement(st)) bad.push(`top-level statement ${ts.SyntaxKind[st.kind]}`);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!d.initializer) continue;
        let effect = false;
        walk(d.initializer, (n) => {
          if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
          if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && !isInsideFunction(n, d.initializer!)) {
            const callee = ts.isCallExpression(n) ? n.expression : n.expression;
            // `new Set([...])` / `new Map(...)` / a RegExp literal are values, not effects.
            if (ts.isNewExpression(n) && ts.isIdentifier(callee) && ["Set", "Map", "RegExp"].includes(callee.text)) return;
            effect = true;
          }
        });
        if (effect) bad.push(`top-level call in ${d.name.getText(src)}`);
      }
    }
  }
  walk(src, (n) => {
    if (ts.isIdentifier(n) && FORBIDDEN_NAMES.has(n.text)) {
      const p = n.parent;
      const isPropName = p && (ts.isPropertyAccessExpression(p) && p.name === n || ts.isPropertyAssignment(p) && p.name === n || ts.isPropertySignature(p) && p.name === n);
      if (!isPropName) bad.push(`names ${n.text}`);
    }
    if (ts.isIdentifier(n) && /^__\w*ForTests$/.test(n.text)) bad.push(`names ${n.text}`);
    if (ts.isPropertyAccessExpression(n) && n.expression.getText(src) === "Math" && n.name.text === "random") bad.push("names Math.random");
    if (ts.isMetaProperty(n)) bad.push("names import.meta");
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) bad.push("dynamic import()");
  });
  return [...new Set(bad)];
}
function isInsideFunction(n: ts.Node, stop: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p && p !== stop.parent; p = p.parent) if (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return true;
  return false;
}

/** Every import edge (static, dynamic, type-only, re-export) of one file, resolved. */
function edgesOf(rel: string, text: string): Array<{ to: string; kind: "static" | "type" | "dynamic" | "reexport"; names: string[]; inFunction: boolean }> {
  const out: Array<{ to: string; kind: "static" | "type" | "dynamic" | "reexport"; names: string[]; inFunction: boolean }> = [];
  const src = sf(rel, text);
  walk(src, (n) => {
    if (ts.isImportDeclaration(n)) out.push({ to: resolveSpec(rel, (n.moduleSpecifier as ts.StringLiteral).text), kind: isTypeOnlyImport(n) ? "type" : "static", names: [], inFunction: false });
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push({ to: resolveSpec(rel, n.moduleSpecifier.text), kind: "reexport", names: [], inFunction: false });
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      let names: string[] = [];
      let p: ts.Node | undefined = n.parent;
      while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) names = p.name.elements.map((e) => (e.propertyName ?? e.name).getText(src)).sort();
      out.push({ to: resolveSpec(rel, n.arguments[0].text), kind: "dynamic", names, inFunction: isInsideFunction(n, src) });
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) out.push({ to: resolveSpec(rel, n.argument.literal.text), kind: "type", names: [], inFunction: false });
  });
  return out;
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("purity: src/judge-rules/ cannot do I/O or tell a replay from production", () => {
  const files = listTs(RULES_DIR);
  test("the rules directory exists and has its entry module", () => {
    expect(files).toContain("src/judge-rules/index.ts");
    expect(files.length).toBeGreaterThanOrEqual(4);
  });
  for (const f of files) test(`${f} is pure`, () => { expect([f, purityOffenders(f, read(f))]).toEqual([f, []]); });
  test("the allowlisted helpers it imports are themselves free of I/O and environment reads", () => {
    for (const h of ["src/goal-intent.ts", "src/fs-write-shapes.ts", "src/resolve-pointer.ts", "src/goal-file-resolution.ts"]) {
      const offenders = purityOffenders(h, read(h)).filter((o) => /names (fetch|Bun|process|globalThis|require|eval|Date|performance)|Math\.random|import\.meta|dynamic import/.test(o));
      expect([h, offenders]).toEqual([h, []]);
    }
  });
  test("the import closure of the rules is exactly the pinned list", () => {
    const seen = new Set<string>();
    const stack = listTs(RULES_DIR);
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const e of edgesOf(f, read(f))) if (e.kind !== "type" && e.to.startsWith("src/")) stack.push(e.to);
    }
    expect([...seen].sort()).toEqual(JUDGE_RULES_IMPORT_CLOSURE);
  });
});

describe("MUST-FAIL: each purity mutant is seen red", () => {
  const f = "src/judge-rules/mutant.ts";
  const red = (text: string) => purityOffenders(f, text);
  test("positive control: a pure rule with an allowlisted helper import is clean", () => {
    expect(red(`import { isEditIntentGoal } from "../goal-intent";\nimport type { ReachGateInput } from "../judge/records";\nconst RE = /x/;\nconst S = new Set(["a"]);\nexport function r(i: ReachGateInput) { return isEditIntentGoal(i.goal) && RE.test(i.goal) && S.has("a"); }\n`)).toEqual([]);
  });
  for (const [name, text] of [
    ["an import from node:fs", `import { readFileSync } from "node:fs";\nexport const r = () => readFileSync;\n`],
    ["a value import from the closed core", `import { reachGate } from "../judge/entries";\nexport const r = reachGate;\n`],
    ["a fetch inside a function", `export function r() { return fetch("http://x"); }\n`],
    ["a process.env read", `export function r() { return process.env.X === "1"; }\n`],
    ["a globalThis replay marker", `export function r() { return (globalThis as any).__vc === true; }\n`],
    ["a clock read", `export function r() { return Date.now() > 0; }\n`],
    ["a random source", `export function r() { return Math.random() > 0.5; }\n`],
    ["a stack inspection", `export function r() { return String(new Error().stack).includes("corpus"); }\n`],
    ["import.meta", `export function r() { return import.meta.dir; }\n`],
    ["a dynamic import", `export async function r() { return import("node:fs"); }\n`],
    ["a top-level effect", `export const x = (() => 1)();\n`],
    ["a re-export of an outside module", `export { isEditIntentGoal } from "../goal-intent";\n`],
    ["a test seam name", `export function r() { return __rulesForTests; }\n`],
  ] as const) test(`red: ${name}`, () => { expect(red(text).length).toBeGreaterThan(0); });
});

describe("output-schema clamp: an adversarial rules module falls back closed", () => {
  const g = "File a gap recording that the review stage stalled.";
  const rIn = reachInput({ goal: g, writeEvidence: { persistedWrites: ["substrateGap_write"], targets: ["substrateGap_write"] }, targets: ["substrateGap_write"], landed: false });
  const pass = { reached: true, hollow_class: null, reason_code: "write-goal-gate:pass", deterministic: false };
  const mk = (reach: unknown) => ({ reachGate: () => reach, floorDecide: () => ({ ...pass, reason_code: "floor:reached", fabricated_transcript: false }), floorShortcutAllowed: () => ({ allowed: true, reason_code: "shortcut:own-pathway" }), reframeAccept: () => ({ accept: true, reason_code: "reframe:accepted" }) });
  test("positive control: a well-formed pass is applied (not a fallback)", () => {
    expect(judge.withRules(mk(pass), () => judge.reachGate(rIn))).toMatchObject({ hollow: false, fell_back: false });
  });
  for (const [name, out] of [
    ["an extra key", { ...pass, credit: "skip" }],
    ["a non-boolean reached", { ...pass, reached: "yes" }],
    ["an unknown hollow class", { reached: false, hollow_class: "made-up", reason_code: "write-goal-no-artifact:write", deterministic: true }],
    ["a forged deterministic reason", { ...pass, reason_code: "deterministic:verified-artifact-written" }],
    ["a reached verdict carrying a hollow class", { ...pass, hollow_class: "write-goal-no-artifact" }],
    ["not an object", "reached"],
  ] as const) test(`refused: ${name}`, () => {
    const v = judge.withRules(mk(out), () => judge.reachGate(rIn));
    expect(v).toMatchObject({ hollow: true, fell_back: true, hollow_class: "judge-rules-refused" });
    expect(v.reason).toStartWith("deterministic:judge-rules-refused");
  });
  test("a rule that throws, or rules that did not load, fall back closed at every entry", () => {
    const boom = { reachGate: () => { throw new Error("x"); }, floorDecide: () => { throw new Error("x"); }, floorShortcutAllowed: () => { throw new Error("x"); }, reframeAccept: () => { throw new Error("x"); } };
    for (const r of [boom, null]) {
      judge.withRules(r as never, () => {
        expect(judge.reachGate(rIn)).toMatchObject({ hollow: true, fell_back: true });
        expect(judge.floorVerdict(floorInput({ goal: "Explain X", targets: [], writes: [], answerText: "ok", verdictReason: null, toolsTotal: 0, toolsOk: 0, groundedReads: 0 }), { reached: true, reason: "ok" })).toMatchObject({ reached: false, fell_back: true });
        expect(judge.floorShortcut(shortcutInput({ goal: "Explain X", activities: ["universal-tool-fallback"], borrowed: false, targets: [] }))).toMatchObject({ allowed: false, fell_back: true });
        expect(judge.reframeAccept(reframeInput({ goal: "Explain X", originalTargets: [], alternatives: [], altReached: true, substantive: ["llm_completion"], onlyRawInput: false, skippedPlannedRetrieval: false, origWantedDerived: false }))).toMatchObject({ accept: false, fell_back: true });
      });
    }
    expect(Object.keys(judge.judgeRulesFellBack()).sort()).toEqual(["floorShortcut", "floorVerdict", "reachGate", "reframeAccept"]);
  });
  test("a shortcut or reframe output whose decision disagrees with its code is refused", () => {
    const lie = { ...mk(pass), floorShortcutAllowed: () => ({ allowed: true, reason_code: "shortcut:edit-goal" }), reframeAccept: () => ({ accept: true, reason_code: "reframe:punt-only" }) };
    judge.withRules(lie as never, () => {
      expect(judge.floorShortcut(shortcutInput({ goal: "x", activities: ["universal-tool-fallback"], borrowed: false, targets: [] }))).toMatchObject({ allowed: false, fell_back: true });
      expect(judge.reframeAccept(reframeInput({ goal: "x", originalTargets: [], alternatives: [], altReached: true, substantive: ["a"], onlyRawInput: false, skippedPlannedRetrieval: false, origWantedDerived: false }))).toMatchObject({ accept: false, fell_back: true });
    });
  });
  test("an unknown input schema is a refusal, never a default", () => {
    expect(judge.reachGate({ ...rIn, schema: 2 } as never)).toMatchObject({ hollow: true, fell_back: true });
  });
});

describe("the edge: one closed site imports the open rules", () => {
  const all = listTs("src/");
  const importers = all.flatMap((f) => edgesOf(f, read(f)).filter((e) => e.to.startsWith(RULES_DIR) && !f.startsWith(RULES_DIR)).map((e) => ({ from: f, ...e })));
  test("only src/judge/entries.ts imports src/judge-rules/, by one dynamic import of exactly the entry symbols", () => {
    expect(importers.map((e) => `${e.from} ${e.kind} ${e.to} [${e.names.join(",")}]`)).toEqual([`${CORE} dynamic src/judge-rules/index.ts [${ENTRY_SYMBOLS.join(",")}]`]);
  });
  test("src/judge-rules/ imports nothing from src/judge/ except types, and nothing from index.ts", () => {
    for (const f of listTs(RULES_DIR)) for (const e of edgesOf(f, read(f))) {
      if (e.to.startsWith("src/judge/")) expect([f, e.to, e.kind]).toEqual([f, e.to, "type"]);
      expect(e.to).not.toBe("src/index.ts");
    }
  });
  test("no test outside this directory and test/judge-rules/ reaches into src/judge-rules/ as a value except the write-goal pins", () => {
    const t = listTs("test/", true).filter((f) => !f.startsWith("test/verdict-corpus/") && !f.startsWith("test/judge-rules/") && !f.startsWith("test/judge-split/"));
    const reach = t.flatMap((f) => edgesOf(f, read(f)).filter((e) => e.to.startsWith(RULES_DIR) && e.kind !== "type").map(() => f));
    expect([...new Set(reach)].sort()).toEqual(["test/write-goal-artifact.test.ts"]);
  });
  test("MUST-FAIL: the edge checker sees a static import, an extra symbol and a second importer", () => {
    const e1 = edgesOf("src/judge/x.ts", `import { reachGate } from "../judge-rules/index";\n`);
    expect(e1[0]).toMatchObject({ kind: "static", to: "src/judge-rules/index.ts" });
    const e2 = edgesOf("src/judge/entries.ts", `const { reachGate, floorDecide, floorShortcutAllowed, reframeAccept, extra } = await import("../judge-rules/index");\n`);
    expect(e2[0]!.names).toEqual(["extra", "floorDecide", "floorShortcutAllowed", "reachGate", "reframeAccept"]);
    expect(e2[0]!.names).not.toEqual(ENTRY_SYMBOLS);
  });
});
