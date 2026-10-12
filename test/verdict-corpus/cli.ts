// VERDICT CORPUS CLI (closed). Run from the goal-host root.
//   bun test/verdict-corpus/cli.ts run --json [--ever-green <file>]   every case, classified; exit 1 on any flip
//   bun test/verdict-corpus/cli.ts append-check --from <n>             cases n.. must observe their status_at_append
//   bun test/verdict-corpus/cli.ts heldout --sample <file.jsonl> --json  the verdict this tree gives each held-out record
// The admission glue compares these JSON outputs itself; it never uses this tree's compare logic.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendCheck, observe, runCorpus, type CorpusCase } from "./runner";

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
} else if (argv[0] === "heldout") {
  const sample = flag("--sample");
  if (!sample) { console.error("heldout: --sample <file.jsonl> is required"); process.exit(2); }
  const out: Array<{ record_hash: string; reached: boolean | null; error?: string }> = [];
  for (const line of readFileSync(sample, "utf8").split("\n").filter(Boolean)) {
    const rec = JSON.parse(line) as { record_hash: string; judge_input: CorpusCase["input"]; llm?: CorpusCase["llm"]; ports?: Record<string, unknown> };
    const c = { schema: 1, id: "0000-heldout", class: "heldout", entry: rec.judge_input?.entry, credit_class: "", edit_site: "", provenance: { source: "heldout", recorded: "", note: "" }, input: rec.judge_input, llm: rec.llm ?? null, ports: rec.ports ?? {}, expect: {}, status_at_append: "green", control: false, licenses: null } as unknown as CorpusCase;
    try {
      const o = observe(c);
      out.push({ record_hash: rec.record_hash, reached: o === "entry_missing" ? null : (o.reached ?? null) });
    } catch (e) { out.push({ record_hash: rec.record_hash, reached: null, error: (e as Error)?.message ?? String(e) }); }
  }
  console.log(JSON.stringify(out));
} else {
  console.error("usage: cli.ts run --json [--ever-green <f>] | append-check --from <n> | heldout --sample <f> --json");
  process.exit(2);
}
