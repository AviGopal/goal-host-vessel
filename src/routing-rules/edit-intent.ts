// THE EDIT-INTENT ROUTING RULES (pure). Which goals go to feature_compose, and onto which file.
//
// Two decisions, each taken where goal-host takes it today and each called by the closed core in
// src/routing-core/entries.ts, which owns every read (workspace search, gap records) and clamps what comes back:
//   - decideDoor: at /run-goal, whether a goal that named no file is dispatched as restated onto the file the
//     pathless resolution found (goal-file-resolution.ts), or as written;
//
// Version 1 is today's behaviour, moved verbatim from index.ts: a restatement the resolver made is always accepted,
// and the hand-off predicate is the early edit-intent check. The core keeps a copy of both as its floor
// (src/routing-core/floor.ts), used only when an answer from here fails the core's clamp.
//
// PURITY. This module does no I/O and reads no clock, randomness or environment; it imports only type-only modules and
// the pure goal-text helpers the purity test allowlists. A rule that could tell replay from production could pass the
// corpus and behave differently live.

import type { DoorDecision, DoorInput } from "../routing-core/types";

/** The door: v1 accepts the resolver's restatement whenever it made one (today's behaviour). */
export function decideDoor(input: DoorInput): DoorDecision {
  if (input.restated_goal !== null && input.chosen_file !== null) {
    return { goal: input.restated_goal, target: input.chosen_file, needs_localization: false };
  }
  return { goal: input.goal, target: null, needs_localization: false };
}
