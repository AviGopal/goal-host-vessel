// VERDICT CORPUS CLI (closed). Run from the goal-host root.
//   bun test/verdict-corpus/cli.ts run --json [--ever-green <file>]   every case, classified; exit 1 on any flip
//   bun test/verdict-corpus/cli.ts append-check --from <n>             cases n.. must observe their status_at_append
//   bun test/verdict-corpus/cli.ts heldout --sample <file.jsonl> --json  the verdict this tree gives each held-out record
//   bun test/verdict-corpus/cli.ts check --case <id>                   exit 0 iff that one case replays green (an
//                                                                      operator tool; the gap check is case-check.check.ts)
// The admission glue compares these JSON outputs itself; it never uses this tree's compare logic.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCheck, checkCase, runCorpus } from "./runner";
import { heldoutReplay } from "../../src/judge/captured-to-replay";

const DIR = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

if (argv[0] === "run") {
  const egPath = flag("--ever-green");
  const everGreen = egPath ? new Set<string>(JSON.parse(readFileSync(egPath, "utf8")) as string[]) : null;
  const r = runCorpus(DIR, { everGreen });
  const out = { corpus: r.corpus, fidelity: r.fidelity, chain_ok: r.chain_ok, chain_errors: r.chain_errors, ...r.classified, red: r.results.filter((x) => x.outcome !== "green").map((x) => ({ id: x.id, outcome: x.outcome, diffs: x.diffs })) };
  console.log(JSON.stringify(out, null, argv.includes("--json") ? 0 : 2));
  process.exit(r.chain_ok && r.classified.flips.length === 0 && r.classified.nondeterministic.length === 0 ? 0 : 1);
} else if (argv[0] === "append-check") {
  const from = Number(flag("--from") ?? "1");
  if (!Number.isInteger(from) || from < 1) { console.error("append-check: --from must be an integer >= 1"); process.exit(2); }
  const r = appendCheck(DIR, from);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else if (argv[0] === "check") {
  const id = flag("--case");
  if (!id) { console.error("check: --case <id> is required"); process.exit(2); }
  const r = checkCase(DIR, id);
  console.log(JSON.stringify({ case: id, ...r }));
  process.exit(r.green ? 0 : 1);
} else if (argv[0] === "heldout") {
  // INPUT: JSONL of held-out records {record_hash, family, entry, delivered, input, ports, llm}, where input is the
  // captured record (metadata.judge_input.<entry>). OUTPUT: a JSON array [{record_hash, reached}] where an
  // unreplayable record is {record_hash, reached: null, unreplayable: [fields]}.
  const sample = flag("--sample");
  if (!sample) { console.error("heldout: --sample <file.jsonl> is required"); process.exit(2); }
  const rows = readFileSync(sample, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) as unknown; } catch { return { record_hash: null, family: null }; } });
  console.log(JSON.stringify(await heldoutReplay(rows)));
} else {
  console.error("usage: cli.ts run --json [--ever-green <f>] | append-check --from <n> | heldout --sample <f> --json | check --case <id>");
  process.exit(2);
}
