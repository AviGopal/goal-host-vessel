/**
 * THE SHA RESOLVE MUST CARRY GOAL-HOST'S KEY.
 *
 * landedShaForGoal posted `goal_path_sha` to discovery's /resolve with only a
 * Content-Type header, so discovery's auth middleware answered 401 on every
 * call (≈270 failures in one day, fleet-wide) and every landed-SHA lookup
 * silently degraded to null. Discovery is goal-host's OWN configured endpoint,
 * so attaching the key is the same thing every other goal-host → discovery /
 * vessel call already does.
 *
 * Two checks:
 *   1. behavioural — the request landedShaForGoal sends carries
 *      `Authorization: ApiKey <key>` (fetch stubbed, headers recorded);
 *   2. class — every fetch in src/index.ts to goal-host's configured
 *      discovery `/resolve` or development-vessel `/v2/impulses/resolve`
 *      carries Authorization (or the shared feedAuthHeaders), so the next
 *      keyless sibling is caught without anyone noticing a 401 first.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const MODULE = join(SRC, "landed-sha.ts");

type Recorded = { url: string; headers: Record<string, string> };

function stubFetch(rec: Recorded[], answer: unknown = { content: { sha: "abc123" } }) {
  return (async (input: unknown, init?: RequestInit) => {
    rec.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("SHA resolve auth: landedShaForGoal carries goal-host's API key", () => {
  test("the extracted module exists (index.ts cannot be imported in a test: its top level boots the host)", () => {
    expect(existsSync(MODULE)).toBe(true);
  });

  test("MUST-FAIL: the goal_path_sha request to discovery carries Authorization: ApiKey <key>", async () => {
    const { landedShaForGoal } = await import(MODULE);
    const rec: Recorded[] = [];
    const sha = await landedShaForGoal("land the thing", {
      endpoint: "http://discovery.test",
      apiKey: "test-key-123",
      fetchImpl: stubFetch(rec),
    });
    expect(sha).toBe("abc123");
    expect(rec.length).toBe(1);
    expect(rec[0]!.url).toBe("http://discovery.test/resolve");
    expect(rec[0]!.headers["authorization"]).toBe("ApiKey test-key-123");
    // the key travels in a header, never in the URL
    expect(rec[0]!.url.includes("test-key-123")).toBe(false);
  });

  test("with no key configured no Authorization header is invented (same fail-open as the sibling sites)", async () => {
    const { landedShaForGoal } = await import(MODULE);
    const rec: Recorded[] = [];
    await landedShaForGoal("g", { endpoint: "http://discovery.test", apiKey: "", fetchImpl: stubFetch(rec) });
    expect(rec[0]!.headers["authorization"]).toBeUndefined();
  });

  test("a 401 still degrades to null (the caller's contract is unchanged)", async () => {
    const { landedShaForGoal } = await import(MODULE);
    const f = (async () => new Response("no", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    const warn = console.warn; console.warn = () => {};
    try {
      expect(await landedShaForGoal("g", { endpoint: "http://d", apiKey: "k", fetchImpl: f })).toBeNull();
    } finally { console.warn = warn; }
  });
});

// ── class detector ───────────────────────────────────────────────────────────

function fetchCalls(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = /(?<![\w.])fetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1, j = m.index + m[0].length;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, text: src.slice(m.index, j) });
  }
  return out;
}

// goal-host's OWN configured endpoints (env-configured, never caller-supplied).
const OWN_RESOLVE_URLS = [
  /^fetch\s*\(\s*`\$\{DEV_VESSEL_ENDPOINT\}\/v2\/impulses\/resolve`/,
  /^fetch\s*\(\s*`\$\{DISCOVERY_ENDPOINT\}\/(?:v2\/impulses\/)?resolve`/,
  /^fetch\s*\(\s*DISCOVERY_ENDPOINT\s*\+\s*"\/(?:v2\/impulses\/)?resolve"/,
  /^fetch\s*\(\s*`\$\{Config\.discoveryEndpoint\}\/(?:v2\/impulses\/)?resolve`/,
];

describe("SHA resolve auth: class — no keyless fetch to goal-host's own /resolve", () => {
  test("MUST-FAIL: every fetch in src/index.ts to configured discovery/dev-vessel resolve carries Authorization", () => {
    const src = readFileSync(join(SRC, "index.ts"), "utf8");
    const own = fetchCalls(src).filter((c) => OWN_RESOLVE_URLS.some((r) => r.test(c.text)));
    expect(own.length).toBeGreaterThan(5); // the detector must actually see the sites it guards
    const keyless = own
      .filter((c) => !/Authorization|feedAuthHeaders/.test(c.text))
      .map((c) => `index.ts:${c.line} ${c.text.slice(0, 80).replace(/\s+/g, " ")}`);
    expect(keyless).toEqual([]);
  });

  test("index.ts takes landedShaForGoal from ./landed-sha and no longer defines a keyless copy", () => {
    const src = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(/import\s*\{[^}]*\blandedShaForGoal\b[^}]*\}\s*from\s*["']\.\/landed-sha(?:\.js)?["']/.test(src)).toBe(true);
    expect(/function\s+landedShaForGoal\s*\(/.test(src)).toBe(false);
  });
});
