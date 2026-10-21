// WHO STARTED A DISPATCH IS SERVED WHERE ITS READERS LOOK (row reach-attribution-reads-operator-authority-so-after-the-
// auth-door-a-cockpit-assisted-reach-counts-as-autonomous).
//
// After the inbound door, a record's `operator` is AUTHORITY: set only when the credential carries operator:direct or
// admin. A person driving the cockpit with an ordinary key claims `operator:<id>` in the body; the record keeps it as
// `operator_label`, and `operator` is null. The readers that attribute HANDS (development-vessel goal-reach-tick's
// isHumanDispatch, the Obsidian graph sync's operatorAttributed) read the three dispatch read surfaces, which served
// `operator` alone, so a cockpit-assisted reach read as autonomous.
//
//   [MUST-FAIL] goalWalkState, activeDispatches and GET /executions/:id each carry operator_label and principal
//               ({kind, operator, tag}), through ONE helper (dispatchAttribution), beside `operator` unchanged.
//   [MUST-FAIL] the served principal carries no key id: its tag is a 12-hex sha256 prefix of it (open surfaces).
//   [CONTROL]   the helper is a read: it copies the label and the principal record, nulls them for a record that
//               predates the door, and never sets `operator` (authority still comes only from operatorAuthority).
//
// Source pins for the serializers (importing src/index.ts reads the live dispatch store and arms timers); the helper
// is imported from inbound-auth.ts.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dispatchAttribution, operatorAuthority, principalTag, SELF_PRINCIPAL } from "../src/inbound-auth";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const after = (anchor: string, n: number): string => {
  const i = SRC.indexOf(anchor);
  expect(i, anchor).toBeGreaterThan(-1);
  return SRC.slice(i, i + n);
};

describe("the dispatch read surfaces serve operator_label and principal", () => {
  it("[MUST-FAIL] activeDispatches", () => {
    const body = after('if (type === "activeDispatches") {', 2500);
    expect(body).toMatch(/operator: r\.operator \?\? null,\s*\n\s*\.\.\.dispatchAttribution\(r\),/);
  });
  it("[MUST-FAIL] goalWalkState", () => {
    const body = after('shape: "goalWalkState",\n      body: { dispatchId: rec.dispatchId', 4000);
    expect(body).toContain("operator: rec.operator ?? null, ...dispatchAttribution(rec),");
  });
  it("[MUST-FAIL] GET /executions/:id", () => {
    const body = after('url.pathname.startsWith("/executions/")', 2500);
    expect(body).toMatch(/operator: record\.operator \?\? null,\s*\n\s*\.\.\.dispatchAttribution\(record\),/);
  });
});

describe("the attribution helper is a read, not authority, and publishes no key id", () => {
  const principal = { kind: "key" as const, label: "key:k1", operator: false };
  const k1Tag = createHash("sha256").update("k1").digest("hex").slice(0, 12);
  it("[CONTROL] it serves the claimed label, the principal's kind and authority, and a 12-hex tag of the key id", () => {
    expect(dispatchAttribution({ operator_label: "operator:avi", principal })).toEqual({ operator_label: "operator:avi", principal: { kind: "key", operator: false, tag: k1Tag } });
    expect(k1Tag).toMatch(/^[0-9a-f]{12}$/);
  });
  it("[MUST-FAIL] the served principal never carries the recorded label or the key id", () => {
    const served = JSON.stringify(dispatchAttribution({ operator_label: "operator:avi", principal: { kind: "key", label: "key:secret-key-id-42", operator: true } }));
    expect(served).not.toContain("secret-key-id-42");
    expect(served).not.toContain('"label"');
  });
  it("[CONTROL] the node's own identity and a key-less principal have no tag; two keys have different tags", () => {
    expect(dispatchAttribution({ principal: { kind: "node_self", label: "node-self", operator: false } }).principal).toEqual({ kind: "node_self", operator: false, tag: null });
    expect(principalTag("key:scopes=read")).toBeNull();
    expect(principalTag("key:k1")).not.toBe(principalTag("key:k2"));
  });
  it("[CONTROL] a record that predates the door reads null for both", () => {
    expect(dispatchAttribution({})).toEqual({ operator_label: null, principal: null });
  });
  it("[CONTROL] it carries no `operator` field, and authority still needs an operator credential", () => {
    expect("operator" in dispatchAttribution({ operator_label: "operator:avi", principal })).toBe(false);
    expect(operatorAuthority("operator:avi", SELF_PRINCIPAL)).toBeUndefined();
  });
});
