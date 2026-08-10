// Pins the bodyHonestyPolicy producer (task #61).
//
// The consumer replaces its literal denial-field list WHOLESALE with whatever
// this returns, so the dangerous direction is serving something malformed — not
// serving nothing. Most of these tests are therefore about REFUSING to serve.
import { describe, expect, test } from "bun:test";
import {
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

  test("returns null when absent, so the consumer keeps its logged fallback", async () => {
    // ABSENT MUST NOT LOOK LIKE AN EMPTY POLICY. The consumer's documented
    // behaviour on no-producer is to fall back and log; null preserves exactly
    // that, which is why this producer does not invent a default.
    const p = await resolveBodyHonestyPolicy("/ws", async () => { throw new Error("ENOENT"); });
    expect(p).toBeNull();
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
