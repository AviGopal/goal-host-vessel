import { describe, expect, test } from "bun:test";
import {
  AttemptLedger, DemandBook, InstanceIndex, attemptOutcome, bindingMatches, defaultInstanceKey, instanceKey, newestPerShape,
} from "./walk-instances";

const FIELDS = ["command", "cwd", "timeout"];

describe("U1 the instance key", () => {
  test("ignores pool context, attribution fields and key order", () => {
    const a = instanceKey("bounded_shell", { command: "bun test", cwd: "/r", timeout: 60, goal: "x", poolShape: { big: 1 }, execution_id: "e1", dispatch_id: "d1", caller: "c", task_type: "t", provenance: { p: 1 }, type: "bounded_shell" }, FIELDS);
    const b = instanceKey("bounded_shell", { timeout: 60, cwd: "/r", command: "bun test", goal: "y", execution_id: "e2" }, FIELDS);
    expect(a).toBe(b);
    expect(instanceKey("s", { o: { b: 1, a: 2 } }, ["o"])).toBe(instanceKey("s", { o: { a: 2, b: 1 } }, ["o"]));
  });
  test("differs on command, on cwd, on timeout, and on shape", () => {
    const base = { command: "bun test", cwd: "/r", timeout: 60 };
    const k = instanceKey("bounded_shell", base, FIELDS);
    expect(instanceKey("bounded_shell", { ...base, command: "git ls-remote" }, FIELDS)).not.toBe(k);
    expect(instanceKey("bounded_shell", { ...base, cwd: "/other" }, FIELDS)).not.toBe(k);
    expect(instanceKey("bounded_shell", { ...base, timeout: 120 }, FIELDS)).not.toBe(k);
    expect(instanceKey("shellResult", base, FIELDS)).not.toBe(k);
  });
  test("the default key keeps one instance per (shape, producer)", () => {
    expect(defaultInstanceKey("goal", "seed")).toBe(defaultInstanceKey("goal", "seed"));
    expect(defaultInstanceKey("goal", "seed")).not.toBe(defaultInstanceKey("goal", "satisfier:goal"));
    expect(defaultInstanceKey("goal", undefined)).toBe(defaultInstanceKey("goal", "goal-host-walk"));
  });
});

describe("U2 an identical command is not re-run", () => {
  const k1 = instanceKey("bounded_shell", { command: "cmd1" }, FIELDS);
  test("a key that failed in an earlier attempt is blocked", () => {
    const l = new AttemptLedger();
    l.begin("satisfier:bounded_shell");
    // inside the attempt: not yet blocked
    expect(l.failedBefore(k1)).toBe(false);
    l.end("satisfier:bounded_shell", "curable", 3, [{ reachedEgress: true, ok: false, transient: false, key: k1 }]);
    expect(l.failedBefore(k1)).toBe(true);
    expect(l.failedBefore(instanceKey("bounded_shell", { command: "cmd2" }, FIELDS))).toBe(false);
  });
  test("a transient failure is not recorded; neither is a send refused before egress", () => {
    const l = new AttemptLedger();
    l.begin("p");
    l.end("p", "transient", 3, [{ reachedEgress: true, ok: false, transient: true, key: k1 }]);
    expect(l.failedBefore(k1)).toBe(false);
    l.begin("p");
    l.end("p", "curable", 4, [{ reachedEgress: false, ok: false, transient: false, key: k1 }]);
    expect(l.failedBefore(k1)).toBe(false);
  });
});

describe("U3 attempts stop at max_attempts_per_producer", () => {
  test("cap 3 with a new impulse before each attempt: the 4th is refused", () => {
    const l = new AttemptLedger();
    let v = 1;
    const allowed: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const d = l.decide("p", v);
      const ok = d === "first" || (d === "needs-cap" && l.withinCap("p", 3));
      allowed.push(ok);
      if (!ok) break;
      l.begin("p");
      l.end("p", "curable", v);
      v++; // another producer adds an impulse
    }
    expect(allowed).toEqual([true, true, true, false]);
  });
  test("cap null (field absent): the 2nd is refused", () => {
    const l = new AttemptLedger();
    expect(l.decide("p", 1)).toBe("first");
    l.begin("p"); l.end("p", "curable", 1);
    expect(l.decide("p", 2)).toBe("needs-cap");
    expect(l.withinCap("p", null)).toBe(false);
  });
  test("a success resets the count", () => {
    const l = new AttemptLedger();
    l.begin("p"); l.end("p", "curable", 1);
    l.begin("p"); l.end("p", "ok", 3);
    expect(l.decide("p", 3)).toBe("first");
    expect(l.reattempts).toBe(1);
  });
  test("a transient outcome does not advance the version: re-eligible within the cap with no new impulse", () => {
    const l = new AttemptLedger();
    l.begin("p"); l.end("p", "transient", 5);
    expect(l.decide("p", 5)).toBe("needs-cap");
    expect(l.withinCap("p", 2)).toBe(true);
  });
});

describe("U4 the walk terminates when no new impulse arrives", () => {
  test("cap 5, pool unchanged: not eligible after the first failure", () => {
    const l = new AttemptLedger();
    l.begin("p"); l.end("p", "curable", 4);
    expect(l.decide("p", 4)).toBe("no-new-impulse");
  });
  test("the producer's OWN observation does not re-arm it; another producer's does", () => {
    const l = new AttemptLedger();
    l.begin("p");
    // the attempt's own observation is added before end(), so the version read at end() already includes it
    const afterOwnObservation = 5;
    l.end("p", "curable", afterOwnObservation);
    expect(l.decide("p", afterOwnObservation)).toBe("no-new-impulse");
    expect(l.decide("p", afterOwnObservation + 1)).toBe("needs-cap");
  });
});

describe("U5 structural outcomes and suppressed producers", () => {
  test("structural is never re-eligible, whatever the pool does", () => {
    const l = new AttemptLedger();
    l.begin("p"); l.end("p", "structural", 1);
    expect(l.decide("p", 100)).toBe("structural");
  });
  test("suppressed is never attempted", () => {
    const l = new AttemptLedger(["p"]);
    expect(l.decide("p", 0)).toBe("suppressed");
  });
  test("one outcome per attempt", () => {
    const t = { reachedEgress: true, ok: false, transient: true };
    const c = { reachedEgress: true, ok: false, transient: false };
    const pre = { reachedEgress: false, ok: false, transient: false };
    expect(attemptOutcome({ ok: false, structural: true, sends: [t] })).toBe("structural");
    expect(attemptOutcome({ ok: true, structural: false, sends: [c] })).toBe("ok");
    expect(attemptOutcome({ ok: false, structural: false, sends: [t, pre] })).toBe("transient");
    expect(attemptOutcome({ ok: false, structural: false, sends: [t, c] })).toBe("curable");
    expect(attemptOutcome({ ok: false, structural: false, sends: [pre] })).toBe("curable");
    expect(attemptOutcome({ ok: false, structural: false, sends: [] })).toBe("curable");
  });
});

describe("U6 demand", () => {
  test("a shape present before `since` does not meet it; an instance added after does", () => {
    const idx = new InstanceIndex();
    const d = new DemandBook();
    idx.add("evidenceRecord", { id: "a", key: "evidenceRecord#1", version: 2 });
    expect(d.shapeMet("evidenceRecord", true, idx)).toBe(true);
    d.note({ shape: "evidenceRecord", since: 3, forHop: "hopX", reason: "unbindable" });
    expect(d.shapeMet("evidenceRecord", true, idx)).toBe(false);
    idx.add("evidenceRecord", { id: "b", key: "evidenceRecord#2", version: 4 });
    expect(d.shapeMet("evidenceRecord", true, idx)).toBe(true);
    expect(d.shapeMet("evidenceRecord", false, idx)).toBe(false);
  });
  test("a bound demand is met only by an instance whose bound fields equal it", () => {
    const idx = new InstanceIndex();
    const d = new DemandBook();
    d.note({ shape: "bounded_shell", binding: { command: "bun test" }, since: 1, forHop: "land", reason: "test at HEAD" });
    idx.add("bounded_shell", { id: "a", key: "k1", version: 2, bound: { command: "git ls-remote origin" } });
    expect(d.shapeMet("bounded_shell", true, idx)).toBe(false);
    idx.add("bounded_shell", { id: "b", key: "k2", version: 3, bound: { command: "bun test", cwd: "/r" } });
    expect(d.shapeMet("bounded_shell", true, idx)).toBe(true);
    expect(bindingMatches(undefined, undefined)).toBe(true);
    expect(bindingMatches({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });
  test("newestPerShape keeps the newest instance of each shape", () => {
    const pool = [{ id: "1", metadata: { shape: "a" } }, { id: "2", metadata: { shape: "b" } }, { id: "3", metadata: { shape: "a" } }];
    expect(newestPerShape(pool).map((i) => i.id)).toEqual(["2", "3"]);
    expect(newestPerShape(pool.slice(0, 2)).map((i) => i.id)).toEqual(["1", "2"]);
  });
});

describe("U7 the budget bound", () => {
  test("random attempt/outcome/pool-growth sequences never exceed MAX_STEPS - chain.length re-attempts", () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const outcomes = ["ok", "curable", "transient", "structural"] as const;
    for (let run = 0; run < 300; run++) {
      const MAX_STEPS = 1 + Math.floor(rnd() * 12);
      const cap = rnd() < 0.2 ? null : 1 + Math.floor(rnd() * 5);
      const l = new AttemptLedger();
      let chainLength = 0;
      let version = 1;
      for (let it = 0; it < 200; it++) {
        if (!l.budgetLeft(chainLength, MAX_STEPS)) break;
        if (rnd() < 0.3) version++;
        const p = `p${Math.floor(rnd() * 4)}`;
        const d = l.decide(p, version);
        if (!(d === "first" || (d === "needs-cap" && l.withinCap(p, cap) && l.budgetAllowsReattempt(chainLength, MAX_STEPS)))) continue;
        l.begin(p);
        const o = outcomes[Math.floor(rnd() * outcomes.length)]!;
        if (o === "ok") { chainLength++; version++; }
        l.end(p, o, version);
      }
      expect(chainLength + l.reattempts).toBeLessThanOrEqual(MAX_STEPS);
    }
  });
});
