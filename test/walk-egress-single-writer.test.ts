// THE WALK NEVER WRITES A SINGLE-WRITER POOL ROW (src/walk-egress-guard.ts). Every walk egress carries
// goal-host's own credential, so a model-steered poolImpulse_write naming the verdict corpus status (or a
// trust-root shape) would present that credential for a write only the corpus runner (or an operator) owns.
// Pinned here:
//   (a) a walk-built poolImpulse_write of the runner-only status is refused before any fetch;
//   (b) a trust-root shape likewise;
//   (c) control: an ordinary poolImpulse_write goes out, unchanged;
//   (d) the lists cannot drift from development-vessel's: equal to the vendored manifest, and, where
//       dev-vessel's source is a sibling checkout, covering every shape and reserved id it protects;
//   (e) every walk egress whose pointer is synthesised goes through the guard, and rawResolve maps the
//       refusal to a non-transient failure (never retried).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildResolvePointer, toolPointer } from "../src/resolve-pointer";
import { walkResolveBody } from "../src/applied-write";
import { isTransientFailure } from "../src/transient-failure";
import {
  RUNNER_ONLY_POOL_ID_PREFIXES, RUNNER_ONLY_POOL_IDS, RUNNER_ONLY_POOL_SHAPES, TRUST_ROOT_POOL_SHAPES,
  isWalkEgressRefused, walkEgressFetch, walkEgressRefusal,
} from "../src/walk-egress-guard";

const REPO = join(import.meta.dir, "..");
const indexSrc = readFileSync(join(REPO, "src", "index.ts"), "utf8");

let calls: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    return new Response(JSON.stringify({ success: true, shape: "poolImpulse_write", body: { ok: true, id: "x" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** The body rawResolve POSTs for a walk step: pool defaults + synthesised args, shape last, walkResolveBody. */
function rawResolveInit(shape: string, args: Record<string, unknown>): RequestInit {
  const pointer = buildResolvePointer(shape, { dispatch_id: "d-test", goal_text: "g" }, args);
  return { method: "POST", headers: { "Content-Type": "application/json", Authorization: "ApiKey main-key" }, body: JSON.stringify(walkResolveBody(shape, pointer)) };
}
async function outcome(p: Promise<Response>): Promise<string> {
  try { const r = await p; return `sent ${r.status}`; } catch (e) { return isWalkEgressRefused(e) ? "refused" : `threw ${(e as Error).message}`; }
}

describe("(a) a walk step writing the runner-only corpus status is refused before egress", () => {
  it("by shape, by reserved id, by refusal-record id, vessel-qualified, and in the floor-tool and proxy forms", async () => {
    const res: string[] = [];
    res.push(`shape: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/v2/impulses/resolve", rawResolveInit("poolImpulse_write", { shape: "verdictCorpusStatus", id: "verdictCorpusStatus", source: "verdictCorpusRun", body: { holds: [] } })))}`);
    res.push(`id-only: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", rawResolveInit("poolImpulse_write", { id: "verdictCorpusStatus", body: { holds: [] } })))}`);
    res.push(`refusal-row: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", rawResolveInit("poolImpulse_write", { id: "verdictCorpusWriteRefusal:key_id:x", body: {} })))}`);
    res.push(`refusal-shape: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", rawResolveInit("poolImpulse_write", { shape: "verdictCorpusWriteRefusal", body: {} })))}`);
    res.push(`qualified: ${await outcome(walkEgressFetch("development-vessel:poolImpulse_write", "http://dv/r", rawResolveInit("development-vessel:poolImpulse_write", { shape: "verdictCorpusStatus", body: {} })))}`);
    const uf = { method: "POST", body: JSON.stringify({ impulse: { pointer: toolPointer("poolImpulse_write", { shape: "verdictCorpusStatus", body: { holds: [] } }, { execution_id: "d" }) } }) };
    res.push(`floor-tool: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", uf))}`);
    const proxy = { method: "POST", body: JSON.stringify({ impulse: { pointer: buildResolvePointer("poolImpulse_write", { shape: "verdictCorpusStatus" }, {}) } }) };
    res.push(`template-proxy: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", proxy))}`);
    // The site asked for another shape, but the body the receiving route reads is a pool write.
    const smuggled = { method: "POST", body: JSON.stringify({ impulse: { type: "poolImpulse_write", pointer: { type: "poolImpulse_write", shape: "verdictCorpusStatus" } } }) };
    res.push(`body-typed: ${await outcome(walkEgressFetch("memoryNote_write", "http://dv/r", smuggled))}`);
    const bare = { method: "POST", body: JSON.stringify({ type: "poolImpulse_write", shape: "verdictCorpusStatus" }) };
    res.push(`bare-body: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", bare))}`);
    expect(res).toEqual(["shape: refused", "id-only: refused", "refusal-row: refused", "refusal-shape: refused", "qualified: refused", "floor-tool: refused", "template-proxy: refused", "body-typed: refused", "bare-body: refused"]);
    expect(calls.length).toBe(0);
  });

  it("the refusal is not a transient failure, so no satisfier retries it", () => {
    const why = walkEgressRefusal("poolImpulse_write", { impulse: { pointer: { type: "poolImpulse_write", shape: "verdictCorpusStatus" } } });
    expect(typeof why).toBe("string");
    expect(isTransientFailure(why)).toBe(false);
  });
});

describe("(b) a trust-root shape is refused before egress", () => {
  it("every trust-root shape, by shape and by an id equal to the shape name", async () => {
    const res: string[] = [];
    for (const s of [...TRUST_ROOT_POOL_SHAPES].sort()) {
      res.push(`${s}: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", rawResolveInit("poolImpulse_write", { shape: s, body: { x: 1 } })))}`);
      res.push(`${s}#id: ${await outcome(walkEgressFetch("poolImpulse_write", "http://dv/r", rawResolveInit("poolImpulse_write", { id: s, body: { x: 1 } })))}`);
    }
    expect(res.every((r) => r.endsWith(": refused"))).toBe(true);
    expect(res.length).toBe(TRUST_ROOT_POOL_SHAPES.size * 2);
    expect(calls.length).toBe(0);
  });
});

describe("(c) control: ordinary writes and reads go out unchanged", () => {
  it("an ordinary poolImpulse_write, a read of the status, and a non-pool write each reach fetch once, body intact", async () => {
    const ordinary = rawResolveInit("poolImpulse_write", { shape: "goalNote", id: "note-1", body: { text: "hello" } });
    expect(await outcome(walkEgressFetch("poolImpulse_write", "http://dv/v2/impulses/resolve", ordinary))).toBe("sent 200");
    const read = rawResolveInit("poolImpulse", { shape: "verdictCorpusStatus", id: "verdictCorpusStatus" });
    expect(await outcome(walkEgressFetch("poolImpulse", "http://dv/r", read))).toBe("sent 200");
    const memo = rawResolveInit("memoryNote_write", { note: { id: "verdictCorpusStatus", title: "t", body: "b" } });
    expect(await outcome(walkEgressFetch("memoryNote_write", "http://dv/r", memo))).toBe("sent 200");
    expect(calls.length).toBe(3);
    expect(calls[0]!.url).toBe("http://dv/v2/impulses/resolve");
    expect(calls[0]!.body).toEqual(JSON.parse(String(ordinary.body)));
  });
});

// ── (d) drift ────────────────────────────────────────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "walk-egress", "dev-vessel-pool-lists.json"), "utf8")) as {
  dev_vessel_sha: string; runner_only_shapes: string[]; runner_only_ids: string[]; runner_only_id_prefixes: string[]; trust_root_shapes: string[];
};
const sorted = (xs: Iterable<string>) => [...xs].sort();

/** dev-vessel's lists, read from its source: string constants resolved, Set literals and runnerOnlyWriteShape's id checks parsed. */
function parseDevVesselPoolLists(src: string): { runner_only_shapes: string[]; runner_only_ids: string[]; runner_only_id_prefixes: string[]; trust_root_shapes: string[] } | string {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)(?:\s*:\s*[^=]+?)?\s*=\s*['"]([^'"]*)['"]\s*;/g)) consts.set(m[1]!, m[2]!);
  const item = (raw: string): string | null => {
    const t = raw.trim();
    const lit = t.match(/^['"]([^'"]*)['"]$/);
    if (lit) return lit[1]!;
    return consts.get(t) ?? null;
  };
  const setOf = (name: string): string[] | string => {
    const m = src.match(new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*new\\s+Set\\(\\[([^\\]]*)\\]\\)`));
    if (!m) return `${name} not found`;
    const out: string[] = [];
    for (const raw of m[1]!.split(",").filter((x) => x.trim().length > 0)) { const v = item(raw); if (v === null) return `${name}: unresolved member ${raw.trim()}`; out.push(v); }
    return out;
  };
  const trust = setOf("TRUST_ROOT_POOL_SHAPES");
  if (typeof trust === "string") return trust;
  // A dev-vessel that predates the runner grant protects no runner-only row: only then (it names no corpus status
  // at all) is the runner set read as empty. Any other absence is a rename the check must not pass over.
  if (!/verdictCorpusStatus/.test(src)) return { runner_only_shapes: [], runner_only_ids: [], runner_only_id_prefixes: [], trust_root_shapes: sorted(trust) };
  const runner = setOf("RUNNER_ONLY_POOL_SHAPES");
  if (typeof runner === "string") return runner;
  const fn = src.match(/export\s+function\s+runnerOnlyWriteShape\b[\s\S]*?\n\}/);
  if (!fn) return "runnerOnlyWriteShape not found";
  const ids: string[] = [];
  for (const m of fn[0].matchAll(/(?<!typeof\s+)pointer\.id\s*===\s*([A-Za-z_][A-Za-z0-9_]*|['"][^'"]*['"])/g)) { const v = item(m[1]!); if (v === null) return `unresolved id ${m[1]}`; ids.push(v); }
  const prefixes: string[] = [];
  for (const m of fn[0].matchAll(/startsWith\(\s*([A-Za-z_][A-Za-z0-9_]*|['"][^'"]*['"])\s*\)/g)) { const v = item(m[1]!); if (v === null) return `unresolved prefix ${m[1]}`; prefixes.push(v); }
  return { runner_only_shapes: sorted(runner), runner_only_ids: sorted(ids), runner_only_id_prefixes: sorted(prefixes), trust_root_shapes: sorted(trust) };
}

describe("(d) the lists cannot drift from development-vessel's", () => {
  it("the guard's sets equal the vendored manifest of dev-vessel's lists", () => {
    expect({
      runner_only_shapes: sorted(RUNNER_ONLY_POOL_SHAPES), runner_only_ids: sorted(RUNNER_ONLY_POOL_IDS),
      runner_only_id_prefixes: sorted(RUNNER_ONLY_POOL_ID_PREFIXES), trust_root_shapes: sorted(TRUST_ROOT_POOL_SHAPES),
    }).toEqual({
      runner_only_shapes: sorted(manifest.runner_only_shapes), runner_only_ids: sorted(manifest.runner_only_ids),
      runner_only_id_prefixes: sorted(manifest.runner_only_id_prefixes), trust_root_shapes: sorted(manifest.trust_root_shapes),
    });
    expect(manifest.dev_vessel_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  // In the fleet layout (the super-repo clone, /vessels) dev-vessel is a sibling of this repo, so this runs in the gate.
  const sibling = join(REPO, "..", "development-vessel", "src", "resolvers", "pool-impulse.ts");
  const present = existsSync(sibling);
  if (!present) console.warn(`[walk-egress drift] SKIPPED the sibling check: no development-vessel source at ${sibling} (the manifest check above still ran)`);
  it.skipIf(!present)("covers every shape, reserved id and id prefix the sibling dev-vessel source protects", () => {
    const parsed = parseDevVesselPoolLists(readFileSync(sibling, "utf8"));
    expect(typeof parsed === "string" ? `unparseable dev-vessel source: ${parsed}` : "parsed").toBe("parsed");
    if (typeof parsed === "string") return;
    const missing = [
      ...parsed.runner_only_shapes.filter((s) => !RUNNER_ONLY_POOL_SHAPES.has(s)).map((s) => `runner-only shape ${s}`),
      ...parsed.trust_root_shapes.filter((s) => !TRUST_ROOT_POOL_SHAPES.has(s)).map((s) => `trust-root shape ${s}`),
      ...parsed.runner_only_ids.filter((s) => !RUNNER_ONLY_POOL_IDS.has(s)).map((s) => `runner-only id ${s}`),
      ...parsed.runner_only_id_prefixes.filter((s) => !RUNNER_ONLY_POOL_ID_PREFIXES.includes(s)).map((s) => `runner-only id prefix ${s}`),
    ];
    expect(missing).toEqual([]);
  });

  it("the parser reads dev-vessel's form (pinned on a fixture of the pinned sha's declarations)", () => {
    const fixture = [
      "export const TRUST_ROOT_POOL_SHAPES: ReadonlySet<string> = new Set(['substrateNodes', 'autonomyScope', 'spendEnvelope', 'calibrationWindow', 'scriptRunnerAllowlist', 'operatorHold', 'posteriorReplayAuthorization', 'verdictCorpusWriter']);",
      "export const VERDICT_CORPUS_STATUS_SHAPE = 'verdictCorpusStatus';",
      "export const VERDICT_CORPUS_STATUS_ID = 'verdictCorpusStatus';",
      "export const VERDICT_CORPUS_REFUSAL_SHAPE = 'verdictCorpusWriteRefusal';",
      "const VERDICT_CORPUS_REFUSAL_ID_PREFIX = 'verdictCorpusWriteRefusal:';",
      "export const RUNNER_ONLY_POOL_SHAPES: ReadonlySet<string> = new Set([VERDICT_CORPUS_STATUS_SHAPE, VERDICT_CORPUS_REFUSAL_SHAPE]);",
      "export function runnerOnlyWriteShape(pointer: { id?: string; shape?: string }): string | null {",
      "  if (typeof pointer.shape === 'string' && RUNNER_ONLY_POOL_SHAPES.has(pointer.shape)) return pointer.shape;",
      "  if (pointer.id === VERDICT_CORPUS_STATUS_ID) return VERDICT_CORPUS_STATUS_SHAPE;",
      "  if (typeof pointer.id === 'string' && pointer.id.startsWith(VERDICT_CORPUS_REFUSAL_ID_PREFIX)) return VERDICT_CORPUS_REFUSAL_SHAPE;",
      "  return null;",
      "}",
    ].join("\n");
    const { dev_vessel_sha: _sha, source: _src, ...lists } = manifest as typeof manifest & { source: string };
    // A renamed runner set is unparseable, never read as "nothing to cover".
    expect(typeof parseDevVesselPoolLists(fixture.replace(/RUNNER_ONLY_POOL_SHAPES/g, "RUNNER_POOL_SHAPES"))).toBe("string");
    expect(parseDevVesselPoolLists(fixture)).toEqual({ runner_only_shapes: sorted(lists.runner_only_shapes), runner_only_ids: sorted(lists.runner_only_ids), runner_only_id_prefixes: sorted(lists.runner_only_id_prefixes), trust_root_shapes: sorted(lists.trust_root_shapes) });
  });
});

// ── (e) wiring ───────────────────────────────────────────────────────────────────────────────────────────────
/** The source of one function/closure, from its declaration to the next top-level-looking declaration marker. */
function region(startMarker: string, endMarker: string): string {
  const a = indexSrc.indexOf(startMarker);
  expect(`${startMarker.slice(0, 60)} found: ${a > 0}`).toBe(`${startMarker.slice(0, 60)} found: true`);
  const b = indexSrc.indexOf(endMarker, a + startMarker.length);
  expect(`${endMarker.slice(0, 60)} found: ${b > a}`).toBe(`${endMarker.slice(0, 60)} found: true`);
  return indexSrc.slice(a, b);
}

describe("(e) every synthesised walk egress goes through the guard", () => {
  const sites: Array<[string, string, string]> = [
    ["rawResolve", "const rawResolve = async (shape: string, endpoint: string, resolvePath: string", "const refuseReapply = (shape: string, site: string)"],
    ["ufExecuteTool", "async function ufExecuteTool(", "\n/**\n * Recompute a countable goal's answer"],
    ["buildProxyResolver", "function buildProxyResolver(shape: string)", "\n}\n"],
    ["buildDiscoveryProxyResolver", "function buildDiscoveryProxyResolver(shape: string)", "\n}\n"],
  ];
  for (const [name, start, end] of sites) {
    it(`${name}: its producer POST is walkEgressFetch, and it holds no raw fetch of a synthesised pointer`, () => {
      const body = region(start, end);
      expect(body).toContain("await walkEgressFetch(");
      // Any other fetch left in the region must carry a literal pointer type (discovery lookups, schema reads).
      const raw = [...body.matchAll(/await fetch\(/g)].map((m) => body.slice(m.index!, m.index! + 400));
      for (const r of raw) expect(`${name}: ${/type: "[A-Za-z_:]+"/.test(r) ? "literal" : r.slice(0, 160)}`).toBe(`${name}: literal`);
    });
  }

  it("rawResolve maps the refusal to its own failure path: recorded with the guard's reason, no transport label", () => {
    const body = region("const rawResolve = async (shape: string, endpoint: string, resolvePath: string", "const refuseReapply = (shape: string, site: string)");
    expect(body).toMatch(/if \(isWalkEgressRefused\(e\)\) \{\s*noteRawResolveFailure\(shape, e\.message[^\n]*\n[^\n]*\n\s*return null;/);
  });
});
