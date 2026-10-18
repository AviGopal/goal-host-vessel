// THE ROUTING FLOOR (closed). A verbatim copy of the v1 rules in src/routing-rules/edit-intent.ts, which is today's
// behaviour as it stood in index.ts. The core (entries.ts) uses it only when an answer from the open rules fails its
// clamp, and counts that fall-back. It never changes with the rules: a lane edit to the rules cannot move it.
import type { DoorDecision, DoorInput, HandoffDecision, HandoffInput } from "./types";
import { asksForDescriptionUnderChangeProhibition, canonicalGoalText, prohibitsAnyMutation } from "../goal-intent";

/** The door floor: accepts the resolver's restatement whenever it made one (today's behaviour). */
export function floorDoor(input: DoorInput): DoorDecision {
  if (input.restated_goal !== null && input.chosen_file !== null) {
    return { goal: input.restated_goal, target: input.chosen_file, needs_localization: false };
  }
  return { goal: input.goal, target: null, needs_localization: false };
}

const FILE_PATH = /repos\/([\w.-]+)\/[\w.\/-]+\.\w+/;
const FILE_PATH_ALL = /repos\/[\w.-]+\/[\w.\/\-]+\.\w+/g;

/**
 * The early edit-intent check: a goal that names a repos/<vessel>/<path>.<ext> file AND carries an edit verb skips the
 * walk and goes straight to feature_compose.
 *
 * EDIT-VERB predicate: the same clean edit-verb set as the late 0-step detector (goalIsEditIntent in index.ts). Two
 * substrate-authored cutovers once polluted it with READ verbs (report/read/count/list/show/summarize/explain/...), which
 * made read-only goals that named one file route to feature_compose and commit an unrequested edit. Keep this list
 * IDENTICAL to the late detectors.
 *
 * READ-ONLY intent: a goal that reports/reads/summarizes/explains/counts a file's content or a field is not an edit,
 * even when it names exactly one repos file.
 *
 * FILE-ONLY: a goal naming exactly one repos source file with no edit verb, no read-only verb and no interrogative is
 * also an edit intent (the late detector's file-path-only test), but a read-only goal is never hijacked into an edit.
 */
export function floorHandoff(input: HandoffInput): HandoffDecision {
  // One canonical goal text (canonicalGoalText), and a goal that forbids every change is never handed to a landing compose:
  // the same prohibitsAnyMutation that isEditIntentGoal reads (a-negated-edit-instruction-is-routed-to-a-landing-compose,
  // user ruling 2026-10-17T00:00:17Z). Its edit verb sits INSIDE the clause that forbids it.
  const g = canonicalGoalText(input.goal_for_routing);
  if (prohibitsAnyMutation(g)) return { route: "walk", target: null };
  // A goal that asks for a description and forbids change in any form is not handed off either, whatever change verb its
  // description names ("Leave the file untouched and tell me what would change in <file>", goal-intent.ts).
  if (asksForDescriptionUnderChangeProhibition(g)) return { route: "walk", target: null };
  const enabled = input.route_enabled;
  const fileMatch = enabled ? g.match(FILE_PATH) : null;
  const editVerb = fileMatch ? /\b(edit|add|insert|append|prepend|change|modify|replace|fix|remove|delete|update|rename|refactor|wire|guard|create|register|scaffold)\b/i.test(g) : false;
  const readOnlyVerb = fileMatch
    ? /\b(report|read|show|display|print|summar(?:y|ise|ize|ising|izing)?|explain|describe|what(?:'s| is| are)|which|value of|the\s+\w+\s+of|count|how many|number of|list|enumerate|tell me|based on|overview|gist)\b/i.test(g)
    : false;
  const interrogative = fileMatch ? (/\?\s*$/.test(g.trim()) || /^\s*(what|how many|how much|how long|how big|which|whose|whether|count|list|show me|tell me|is there|are there|does |do |can )/i.test(g) || /\b(percentage|fraction|proportion|ratio|average|mean|median|number of|how many)\b/i.test(g)) : false;
  const fileOnly = enabled && fileMatch && !editVerb && !readOnlyVerb && !interrogative
    ? (g.match(FILE_PATH_ALL) ?? []).length === 1
    : false;
  if (enabled && fileMatch && (editVerb || fileOnly)) return { route: "feature_compose", target: fileMatch[0]! };
  return { route: "walk", target: null };
}
