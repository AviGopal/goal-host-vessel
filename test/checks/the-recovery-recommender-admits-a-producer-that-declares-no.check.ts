import { it, expect } from "bun:test";
import * as mod from "../../src/write-door.js";

it("recovery_pick counts an undeclared-output producer on a non-admitted goal", () => {
  mod.resetWriteDoorCounters();
  // A producer that declares NO output shapes: cannot be dropped blind, but must be COUNTED and RECORDED.
  const items = ["producer-with-no-declared-outputs"];
  // admitted=false, door=recovery_pick, goal_hash from the report context
  mod.writeDoorFilter(items, () => [], false, "recovery_pick", "ee232b2");
  // INTENT: it must be counted under the recovery_pick door
  expect(mod.writeDoorCounters().recovery_pick).toBeGreaterThan(0);
});
