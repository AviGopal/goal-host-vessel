// A SPOOLED VERDICT'S RETRY BODY CARRIES NO INTERNAL TRY COUNT (OP-1 c, qa review).
//
// drainReachSpool keeps an {updated:0} entry for a bounded number of retries, recording the count in the spooled
// line as a private field (__no_row_tries) that must be stripped before the body is sent to POST /reach. The first
// drain sends the original line, which has no such field, so the existing test could not see the stripping; removing
// it survived. This drains the same entry repeatedly and asserts every RETRY body is exactly the original verdict body.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "op1-spool-body-"));
const SPOOL = join(root, "spool.jsonl");
const prevRoot = process.env["WORKSPACE_ROOT"];
const realFetch = globalThis.fetch;
const sent: string[] = [];
let drain: (path: string) => Promise<void>;
beforeAll(async () => {
  process.env["WORKSPACE_ROOT"] = root;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  globalThis.fetch = ((input: unknown, init?: { body?: unknown }) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/v2/activities/execution-traces/reach")) {
      sent.push(String(init?.body ?? ""));
      return Promise.resolve(new Response(JSON.stringify({ updated: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  drain = (await import("../src/index")).drainReachSpool as typeof drain;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const BODY = JSON.stringify({ execution_id: "walk-satisfier-5-1", reached: false, completion_shapes: [], reason: "r", goal_hash: "abc12345" });

describe("MUST-FAIL — the retry body is the verdict body, without the spool's try count", () => {
  test("every body sent across retries equals the original and has no __no_row_tries", async () => {
    writeFileSync(SPOOL, BODY + "\n");
    await drain(SPOOL); // first send: the original line
    expect(JSON.parse(readFileSync(SPOOL, "utf8").trim()).__no_row_tries).toBe(1); // the spool keeps the count…
    await drain(SPOOL); // first RETRY: the spooled line now carries __no_row_tries
    await drain(SPOOL);
    expect(sent.length).toBe(3);
    for (const b of sent) {
      expect(b).not.toContain("__no_row_tries"); // …the wire never does
      expect(JSON.parse(b)).toEqual(JSON.parse(BODY));
    }
  });
});
