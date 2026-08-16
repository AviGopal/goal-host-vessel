// Pins the bodyHonestyPolicy producer (task #61).
//
// The consumer replaces its literal denial-field list WHOLESALE with whatever
// this returns, so the dangerous direction is serving something malformed — not
// serving nothing. Most of these tests are therefore about REFUSING to serve.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BODY_HONESTY_POLICY,
  bodyHonestyPolicyPath,
  isUsablePolicy,
  resolveBodyHonestyPolicy,
} from "./body-honesty-policy";

const VALID = {
  envelopeKeys: ["body", "content"],
  flagFields: ["success", "ok"],
  truthyDenialFields: ["deferred", "unreachable"],
  errorFields: ["error", "failure_mode"],
  statusFields: ["status"],
  payloadFields: ["content", "rows"],
  denialTextPattern: "(missing|refused)",
};

describe("bodyHonestyPolicyPath", () => {
  test("uses the same volume convention as the llm model policy", () => {
    expect(bodyHonestyPolicyPath("/ws")).toBe("/ws/policies/body-honesty-policy.json");
  });
});

describe("isUsablePolicy", () => {
  test("accepts a well-formed policy", () => {
    expect(isUsablePolicy(VALID)).toBe(true);
  });

  test("REFUSES a policy that marks nothing as a denial", () => {
    // The failure that matters: the consumer swaps in whatever is served, so
    // empty flag+error fields would mean "no body is ever a denial" — silently
    // disabling the honesty check across every walk. Serving nothing is safe;
    // serving this is not.
    expect(isUsablePolicy({ ...VALID, flagFields: [], errorFields: [] })).toBe(false);
  });

  test("REFUSES an invalid denialTextPattern", () => {
    // The consumer feeds this to RegExp inside the walk. An unbalanced group
    // would throw there — the worst possible place to find out.
    expect(isUsablePolicy({ ...VALID, denialTextPattern: "(unclosed" })).toBe(false);
  });

  test("REFUSES wrong field types rather than coercing them", () => {
    expect(isUsablePolicy({ ...VALID, flagFields: "success" })).toBe(false);
    expect(isUsablePolicy({ ...VALID, statusFields: [200] })).toBe(false);
    expect(isUsablePolicy({ ...VALID, denialTextPattern: "" })).toBe(false);
    expect(isUsablePolicy(null)).toBe(false);
    expect(isUsablePolicy("policy")).toBe(false);
  });

  test("keeps flagFields alone sufficient — errorFields may legitimately be empty", () => {
    expect(isUsablePolicy({ ...VALID, errorFields: [] })).toBe(true);
  });
});

describe("resolveBodyHonestyPolicy", () => {
  test("serves a stored policy", async () => {
    const p = await resolveBodyHonestyPolicy("/ws", async () => JSON.stringify(VALID));
    expect(p?.truthyDenialFields).toEqual(["deferred", "unreachable"]);
  });

  // AMENDED 2026-08-16. This test previously asserted `null` on absence, on the reasoning that
  // absence must not look like an empty policy. That reasoning is still right about EMPTY, and
  // the corrupt/unusable cases below still return null for exactly it. But it was wrong about
  // ABSENT: the file has not existed since 8f8e87e7 untracked it on 2026-08-02, so "absent" was
  // not a transient pre-seed state — it was permanent, and the shape was unservable forever while
  // the walk logged its law-1 fallback on every step for two weeks. Self-healing to the documented
  // default is what makes the shape real; the default is a verbatim copy of the consumer's own
  // literal list, so writing it changes no behaviour.
  test("SELF-HEALS when absent: writes the documented default and serves it", async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const p = await resolveBodyHonestyPolicy(
      "/ws",
      async () => { throw new Error("ENOENT"); },
      async (path, data) => { writes.push({ path, data }); },
    );
    expect(p).toEqual(DEFAULT_BODY_HONESTY_POLICY);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/ws/policies/body-honesty-policy.json");
    expect(JSON.parse(writes[0]!.data)).toEqual(DEFAULT_BODY_HONESTY_POLICY);
  });

  test("the provisioned default is itself usable — it must pass the same gate a stored file does", () => {
    expect(isUsablePolicy(DEFAULT_BODY_HONESTY_POLICY)).toBe(true);
  });

  test("a failed write still serves the default rather than breaking the walk", async () => {
    const p = await resolveBodyHonestyPolicy(
      "/ws",
      async () => { throw new Error("ENOENT"); },
      async () => { throw new Error("EROFS: read-only file system"); },
    );
    expect(p).toEqual(DEFAULT_BODY_HONESTY_POLICY);
  });

  test("returns null on unparseable JSON", async () => {
    expect(await resolveBodyHonestyPolicy("/ws", async () => "{not json")).toBeNull();
  });

  test("returns null on a parseable but unusable policy", async () => {
    // A corrupt file degrades to the literal list, never to a half-valid policy.
    const p = await resolveBodyHonestyPolicy("/ws", async () => JSON.stringify({ ...VALID, flagFields: [], errorFields: [] }));
    expect(p).toBeNull();
  });
});
