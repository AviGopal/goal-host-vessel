// THE EDIT-INTENT ROUTING RULES (pure). Which goals go to feature_compose, and onto which file.
//
// Two decisions, each taken where goal-host takes it today and each called by the closed core in
// src/routing-core/entries.ts, which owns every read (workspace search, gap records) and clamps what comes back:
//   - decideDoor: at /run-goal, whether a goal that named no file is dispatched as restated onto the file the
//     pathless resolution found (goal-file-resolution.ts), or as written;
//   - decideHandoff: before the walk, whether the goal (as restated, plus any gap-record hydration) goes to
//     feature_compose, and which file it names.
// The routing corpus (test/routing-corpus/) replays both through the core and pins what they return.
//
// Version 1 is today's behaviour, moved verbatim from index.ts: a restatement the resolver made is always accepted,
// and the hand-off predicate is the early edit-intent check. The core keeps a copy of both as its floor
// (src/routing-core/floor.ts), used only when an answer from here fails the core's clamp.
//
// PURITY. This module does no I/O and reads no clock, randomness or environment; it imports only type-only modules and
// the pure goal-text helpers the purity test allowlists. A rule that could tell replay from production could pass the
// corpus and behave differently live.

import type { DoorDecision, DoorInput, HandoffDecision, HandoffInput } from "../routing-core/types";

/** The door: v1 accepts the resolver's restatement whenever it made one (today's behaviour). */
export function decideDoor(input: DoorInput): DoorDecision {
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
export function decideHandoff(input: HandoffInput): HandoffDecision {
  const g = input.goal_for_routing;
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
