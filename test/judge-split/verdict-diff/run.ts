// VERDICT-DIFF CLI.
//
//   bun test/judge-split/verdict-diff/run.ts generate [--tree <goal-host root>] [--filter <substr>]
//       Run every scenario against the tree (default: this checkout) and (re)write golden/<id>.json.
//       Use ONLY on the base tree (the commit the split starts from). This is the one command that
//       regenerates the golden whenever the base moves.
//   bun test/judge-split/verdict-diff/run.ts out <dir> [--tree <root>] [--filter <substr>]
//       Run and write the outputs to <dir> (for a byte-for-byte `diff -r` of two trees or two runs).
//   bun test/judge-split/verdict-diff/run.ts check [--tree <root>] [--filter <substr>]
//       Run and compare against the committed golden; exit 1 on any difference.
//
// Typecheck the harness itself: bunx tsc -p test/judge-split/verdict-diff/tsconfig.vd.json
//
// To diff the SPLIT tree against the base golden with THIS harness (no harness-version skew):
//   bun test/judge-split/verdict-diff/run.ts check --tree /path/to/split/goal-host-vessel
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENVIRONMENT_PATH, GOLDEN_DIR, HARNESS_DIR, environmentOf, firstDiff, listScenarios, runAll } from "./runner";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const tree = resolve(flag("--tree") ?? join(HARNESS_DIR, "..", "..", ".."));
const ids = listScenarios(flag("--filter"));

const env = environmentOf(tree);
const results = await runAll(tree, ids);
let bad = 0;
if (cmd === "generate" || cmd === "out") {
  const dir = cmd === "generate" ? GOLDEN_DIR : resolve(argv[1] ?? "verdict-diff-out");
  mkdirSync(dir, { recursive: true });
  for (const r of results) {
    writeFileSync(join(dir, `${r.id}.json`), r.json);
    // The captured console is written next to `out` results only (to localize a diff by hand);
    // the golden is the verdict JSON alone.
    if (r.log && cmd === "out") writeFileSync(join(dir, `${r.id}.log.json`), r.log);
    const fatal = (JSON.parse(r.json) as { fatal?: string }).fatal;
    if (r.exitCode !== 0 || fatal) { bad++; console.error(`${r.id}: exit ${r.exitCode} ${fatal ?? ""}\n${r.stderr.slice(-2000)}`); }
  }
  if (cmd === "generate") writeFileSync(ENVIRONMENT_PATH, JSON.stringify(env, null, 2) + "\n");
  // A full regeneration also drops goldens whose scenario no longer exists.
  if (cmd === "generate" && !flag("--filter")) {
    for (const f of readdirSync(dir)) if (f.endsWith(".json") && !ids.includes(f.replace(/\.json$/, ""))) unlinkSync(join(dir, f));
  }
  console.log(`${cmd}: ${results.length} scenario(s) -> ${dir}${bad ? ` (${bad} FAILED)` : ""}`);
} else if (cmd === "check") {
  const goldenEnv = existsSync(ENVIRONMENT_PATH) ? readFileSync(ENVIRONMENT_PATH, "utf8") : "";
  if (goldenEnv !== JSON.stringify(env, null, 2) + "\n") console.error(`WARNING: environment differs from the golden's (${ENVIRONMENT_PATH}); differences may come from the executor build or bun, not from goal-host:\n  golden: ${goldenEnv.trim()}\n  this:   ${JSON.stringify(env)}`);
  for (const r of results) {
    const gp = join(GOLDEN_DIR, `${r.id}.json`);
    const golden = existsSync(gp) ? readFileSync(gp, "utf8") : "";
    const d = firstDiff(golden, r.json);
    if (d) { bad++; console.error(`DIFF ${r.id}: ${d}`); }
    else console.log(`same ${r.id}`);
  }
  console.log(`check: ${results.length - bad}/${results.length} identical to golden (tree ${tree})`);
} else {
  console.error("usage: run.ts generate|out <dir>|check [--tree <root>] [--filter <substr>]");
  process.exit(2);
}
process.exit(bad ? 1 : 0);
