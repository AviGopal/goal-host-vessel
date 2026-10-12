// A RUNTIME READ OF A MODULE-RELATIVE PATH MUST STAY INSIDE WHAT THE MIRROR DEPLOYS (class detector, case C-hollow-3).
//
// A running node's /vessels/<vessel> is built by mirror-to-live: src/, sql/, scripts/, git-tracked dist/ dirs,
// tsconfig.json and index.ts. Nothing else reaches a running node. A path a runtime module builds relative to itself
// (import.meta.url / import.meta.dir / import.meta.dirname / __dirname, directly or through an alias such as
// `const HERE = dirname(fileURLToPath(import.meta.url))`) that climbs out of src/ into any other top-level directory
// names a file every clone and test gate has and no running node has. The verdict corpus runner read test/verdict-corpus
// that way and found nothing on every node while every gate passed. Data a runtime reads from outside the mirrored set
// goes through a declared resolver (src/judge/corpus-location.ts reads the vessel clone), never a module-relative path.
//
// The scan is static over src/**/*.ts (tests excluded) and the root index.ts: each join()/resolve() whose first argument
// is a module-relative base is evaluated over its string-literal segments; a non-literal segment after the climb is
// reported as unprovable. MUST-FAIL: a fixture module joining "..", "..", "test", "x" is flagged; "..", "sql" is not.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
/** What mirror-to-live deploys (top-level dirs). Tracked dist/ dirs are deployed too; none is read module-relatively. */
export const MIRRORED_DIRS = ["src", "sql", "scripts"] as const;

const BASE = String.raw`(?:dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|import\.meta\.dir(?:name)?|__dirname)`;

export interface Finding { file: string; line: number; target: string; why: string }

/** Pure: findings for one module's source text, given its repo-relative path. */
export function scanModule(fileRel: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const aliases = new Set<string>();
  for (const m of text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${BASE}\s*;`, "g"))) aliases.add(m[1]!);
  const bases = [BASE, ...[...aliases].map((a) => a.replace(/\$/g, "\\$"))].join("|");
  const call = new RegExp(String.raw`\b(?:join|resolve)\(\s*(?:${bases})\s*((?:,\s*[^,()]+)*)\)`, "g");
  const moduleDir = posix.dirname(fileRel);
  for (const m of text.matchAll(call)) {
    const line = text.slice(0, m.index).split("\n").length;
    const args = (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    let cur = moduleDir;
    let unprovable = false;
    for (const a of args) {
      const lit = /^(["'`])([^"'`$]*)\1$/.exec(a);
      if (!lit) { unprovable = true; break; }
      cur = posix.normalize(posix.join(cur, lit[2]!));
    }
    const top = cur.split("/")[0]!;
    if (unprovable) {
      if (cur.startsWith("..") || !(MIRRORED_DIRS as readonly string[]).includes(top)) findings.push({ file: fileRel, line, target: `${cur}/<non-literal>`, why: "climbs out of the mirrored set before a non-literal segment" });
      continue;
    }
    if (cur.startsWith("..")) findings.push({ file: fileRel, line, target: cur, why: "leaves the vessel" });
    else if (!(MIRRORED_DIRS as readonly string[]).includes(top) && cur !== "." && !/^[^/]+\.(?:ts|json)$/.test(cur)) findings.push({ file: fileRel, line, target: cur, why: `${top}/ is not deployed by mirror-to-live` });
  }
  return findings;
}

function runtimeModules(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules") walk(p); }
      else if (n.endsWith(".ts") && !/\.(test|check)\.ts$/.test(n)) out.push(relative(REPO, p).split("\\").join("/"));
    }
  };
  walk(join(REPO, "src"));
  try { if (statSync(join(REPO, "index.ts")).isFile()) out.push("index.ts"); } catch { /* no root index */ }
  return out;
}

describe("runtime module-relative paths stay inside the mirrored set", () => {
  test("MUST-FAIL fixture: a climb into test/ is flagged, a climb into sql/ is not", () => {
    const bad = `import { fileURLToPath } from "node:url";\nexport const D = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "verdict-corpus");`;
    const viaAlias = `const HERE = dirname(fileURLToPath(import.meta.url));\nexport const D = join(HERE, "..", "..", "test", "x");`;
    const ok = `export const S = join(import.meta.dir, "..", "..", "sql", "migrations");\nconst HERE = import.meta.dir;\nexport const J = join(HERE, "..");`;
    expect(scanModule("src/judge/credit-hold.ts", bad).map((f) => f.target)).toEqual(["test/verdict-corpus"]);
    expect(scanModule("src/judge/x.ts", viaAlias).map((f) => f.target)).toEqual(["test/x"]);
    expect(scanModule("src/judge/y.ts", ok)).toEqual([]);
  });

  test("no runtime module of this vessel reads outside what mirror-to-live deploys", () => {
    const mods = runtimeModules();
    expect(mods.length).toBeGreaterThan(10); // the control: the scan saw the source tree
    const findings = mods.flatMap((f) => scanModule(f, readFileSync(join(REPO, f), "utf8")));
    expect(findings.map((f) => `${f.file}:${f.line} -> ${f.target} (${f.why})`)).toEqual([]);
  });
});
