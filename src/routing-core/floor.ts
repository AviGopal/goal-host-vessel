// THE ROUTING FLOOR (closed). A verbatim copy of the v1 rules in src/routing-rules/edit-intent.ts, which is today's
// behaviour as it stood in index.ts. The core (entries.ts) uses it only when an answer from the open rules fails its
// clamp, and counts that fall-back. It never changes with the rules: a lane edit to the rules cannot move it.
import type { DoorDecision, DoorInput } from "./types";

/** The door floor: accepts the resolver's restatement whenever it made one (today's behaviour). */
export function floorDoor(input: DoorInput): DoorDecision {
  if (input.restated_goal !== null && input.chosen_file !== null) {
    return { goal: input.restated_goal, target: input.chosen_file, needs_localization: false };
  }
  return { goal: input.goal, target: null, needs_localization: false };
}
