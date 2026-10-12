// THE ROUTING CORE (closed): the edit-intent route's I/O, clamps and the composed replay entry.
//
// goal-host decides at two sites whether a goal is a file edit, and the decisions are open rules
// (src/routing-rules/edit-intent.ts) pinned by the closed routing corpus (test/routing-corpus/). This module is
// everything around them that the lane must not be able to move:
//   - resolveDoorGoal / resolveDoorRouting: the /run-goal door. It runs the pathless resolution
//     (goal-file-resolution.ts, lane-open, called unchanged) over the caller's search functions, wrapped so every
//     answer is recorded, then asks decideDoor which goal to dispatch;
//   - handoffRoute: the early edit-intent hand-off. It asks decideHandoff whether the goal goes to feature_compose;
//   - goalForRoutingOf: the gap-record hydration of the hand-off goal (moved from index.ts so replay and production
//     compose it the same way);
//   - routeEditIntent: the composed replay entry (door, then hydration, then hand-off), exactly as production chains
//     the two sites. The corpus and the held-out replay call this, never the rules directly, so a rule that is green in
//     the corpus is the rule production calls.
// Every answer from the rules passes a clamp (exact keys and types, and only choices the input offered). An answer
// that fails it is replaced by the floor (floor.ts, today's behaviour) and counted. The rules are handed a deep-frozen
// copy of the input; the clamp and the floor read the core's own.
import { resolvePathlessCodeChangeGoal, isPathlessCodeChangeGoal, extractSearchTerms, type FileSearch } from "../goal-file-resolution";
import { isEditIntentGoal } from "../goal-intent";
import { decideDoor, decideHandoff } from "../routing-rules/edit-intent";
import { floorDoor, floorHandoff } from "./floor";
import { validLocalizationRecord } from "./localization";
import type {
  DoorDecision, DoorInput, EditIntentInput, HandoffDecision, HandoffInput, Hydration, RouteDecision, RoutingLlm, RoutingPorts,
} from "./types";

export const ROUTING_RECORD_SCHEMA = 1;

/** Fall-backs to the floor since process start, by site. A non-zero count means the open rules answered out of schema. */
export const routingFellBack = { door: 0, handoff: 0 };

const REPO_FILE = /^repos\/[\w.-]+\/[\w.\/-]+\.\w+$/;
const keysAre = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

/** The door clamp: the rules may only choose between the goal as written and the resolver's own restatement. */
export function clampDoor(input: DoorInput, out: unknown): DoorDecision | null {
  if (!keysAre(out, ["goal", "target", "needs_localization"])) return null;
  if (typeof out.goal !== "string" || typeof out.needs_localization !== "boolean") return null;
  if (out.target !== null && typeof out.target !== "string") return null;
  if (out.goal === input.goal && out.target === null) return { goal: out.goal, target: null, needs_localization: out.needs_localization };
  if (input.restated_goal !== null && input.chosen_file !== null && out.goal === input.restated_goal && out.target === input.chosen_file && !out.needs_localization) {
    return { goal: out.goal, target: out.target, needs_localization: false };
  }
  return null;
}

/** The hand-off clamp: a route from the closed set; a compose target is a repos file the goal itself names. */
export function clampHandoff(input: HandoffInput, out: unknown): HandoffDecision | null {
  if (!keysAre(out, ["route", "target"])) return null;
  if (out.route === "walk") return out.target === null ? { route: "walk", target: null } : null;
  if (out.route !== "feature_compose") return null;
  if (!input.route_enabled || typeof out.target !== "string" || !REPO_FILE.test(out.target)) return null;
  if (!input.goal_for_routing.includes(out.target)) return null;
  return { route: "feature_compose", target: out.target };
}

/**
 * A deep-frozen structured copy of a rule's input. The rules never hold the core's own input, so a rule that mutates
 * what it is given cannot widen the clamp that judges its answer, nor change what the floor or the caller read after.
 */
function frozenCopy<T>(v: T): T {
  const copy = structuredClone(v);
  const freeze = (o: unknown): void => {
    if (o === null || typeof o !== "object" || Object.isFrozen(o)) return;
    Object.freeze(o);
    for (const k of Object.keys(o as object)) freeze((o as Record<string, unknown>)[k]);
  };
  freeze(copy);
  return copy;
}

/** decideDoor over a frozen copy, clamped against the core's own input; the floor on a refused answer. */
export function doorDecision(input: DoorInput): { decision: DoorDecision; fell_back: boolean } {
  let out: unknown;
  try { out = decideDoor(frozenCopy(input)); } catch { out = undefined; }
  const ok = clampDoor(input, out);
  if (ok) return { decision: ok, fell_back: false };
  routingFellBack.door++;
  console.warn(`[routing] door rules answer refused by the clamp — using the floor (fell_back door=${routingFellBack.door})`);
  return { decision: floorDoor(input), fell_back: true };
}

/** decideHandoff over a frozen copy, clamped against the core's own input; the floor on a refused answer. index.ts calls this at the early edit-intent hand-off. */
export function handoffRoute(input: HandoffInput): HandoffDecision {
  let out: unknown;
  try { out = decideHandoff(frozenCopy(input)); } catch { out = undefined; }
  const ok = clampHandoff(input, out);
  if (ok) return ok;
  routingFellBack.handoff++;
  console.warn(`[routing] hand-off rules answer refused by the clamp — using the floor (fell_back handoff=${routingFellBack.handoff})`);
  return floorHandoff(input);
}

/**
 * The hand-off goal: the dispatched goal, plus the gap record's cited file and summary when the record cites a repos
 * file and the goal names none. Substrate-detected gaps cite their site in the summary, so a gap-id goal routes to
 * feature_compose with the gap's own context.
 */
export function goalForRoutingOf(goal: string, hydration: Hydration | null): string {
  if (hydration && hydration.cited_file && !/repos\/[\w.-]+\/[\w.\/-]+\.\w+/.test(goal)) {
    return `${goal} (gap cites file: ${hydration.cited_file}; fix per gap record: ${hydration.summary.slice(0, 300)})`;
  }
  return goal;
}

/** The lead path restateWithTargetFile writes ("Edit <file> to satisfy the following request."). */
export function restatedFileOf(restated: string): string | null {
  return /^Edit (repos\/\S+) to satisfy the following request\./.exec(restated)?.[1] ?? null;
}

/** What the door saw and decided: the editIntent routing record's door half (the capture writes it). */
export type DoorRecord = {
  schema: typeof ROUTING_RECORD_SCHEMA;
  entry: "editIntent";
  goal: string;
  is_edit_intent: boolean;
  is_pathless_code_change: boolean;
  resolution: { terms: string[]; candidates: string[]; chosen_file: string | null; method: string | null; reads: string[] };
  restated_goal: string | null;
  ports: RoutingPorts;
  llm: RoutingLlm;
  decision: DoorDecision;
  fell_back: boolean;
};

/** The resolver's own restatement line names how it chose; the record keeps that as `method`. */
function methodOf(line: string): string | null {
  if (!/restated with target/.test(line)) return null;
  if (/goal asks callers to USE/.test(line)) return "call_site";
  if (/\(unique hit for /.test(line)) return "unique_term";
  if (/\(symbol declaring /.test(line)) return "symbol_declaration";
  if (/\(declares symbols for \d+ goal words/.test(line)) return "symbol_corroboration";
  if (/\(proposed symbol .* declares in exactly one file\)/.test(line)) return "proposed_symbol";
  if (/exactly one contains /.test(line)) return "proposed_symbol_write_site";
  if (/\(declares \d+ proposed symbols; strict leader\)/.test(line)) return "proposed_corroboration";
  return "other";
}

const searchKey = (term: string, scope: string | undefined, callers: boolean | undefined) => `${scope ?? "*"}|${callers ? 1 : 0}|${term}`;
const symbolKey = (word: string, scope: string | undefined) => `${scope ?? "*"}|${word}`;

/**
 * The door, with the record. Same arguments as resolvePathlessCodeChangeGoal, which it calls unchanged over recording
 * wrappers of the caller's functions; decideDoor then chooses the goal to dispatch.
 */
export async function resolveDoorRouting(
  goal: string,
  search: FileSearch,
  tap?: (message: string) => void,
  symbolSearch?: FileSearch,
  proposeSymbols?: (goal: string) => Promise<readonly string[]>,
  readFileText?: (path: string) => Promise<string | undefined>,
  localization: unknown = null,
): Promise<{ goal: string; record: DoorRecord }> {
  const ports: RoutingPorts = { search: {}, symbol_search: {}, read_file: {} };
  const llm: { propose_symbols: readonly string[] | null } = { propose_symbols: null };
  const candidates = new Set<string>();
  const reads: string[] = [];
  let method: string | null = null;
  const rSearch: FileSearch = async (term, scope, callers) => {
    const hits = await search(term, scope, callers);
    ports.search[searchKey(term, scope, callers)] = [...hits];
    for (const h of hits) candidates.add(h);
    return hits;
  };
  const rSymbol: FileSearch | undefined = symbolSearch && (async (word, scope, callers) => {
    const hits = await symbolSearch(word, scope, callers);
    ports.symbol_search[symbolKey(word, scope)] = [...hits];
    for (const h of hits) candidates.add(h);
    return hits;
  });
  const rPropose = proposeSymbols && (async (g: string) => {
    const out = await proposeSymbols(g);
    llm.propose_symbols = [...out];
    return out;
  });
  const rRead = readFileText && (async (path: string) => {
    const text = await readFileText(path);
    ports.read_file[path] = text ?? null;
    reads.push(path);
    return text;
  });
  const rTap = (m: string) => { method = methodOf(m) ?? method; tap?.(m); };
  const restated = await resolvePathlessCodeChangeGoal(goal, rSearch, rTap, rSymbol, rPropose, rRead);
  const restatedGoal = restated !== goal ? restated : null;
  const chosen = restatedGoal ? restatedFileOf(restatedGoal) : null;
  // A localization record reaches the rules only when it is valid (localization.ts): an invalid one reads as none.
  const doorInput: DoorInput = { goal, restated_goal: restatedGoal, chosen_file: chosen, localization: validLocalizationRecord(localization) ? localization : null };
  const { decision, fell_back } = doorDecision(doorInput);
  if (restatedGoal && decision.goal === goal) tap?.(`routing door: the restatement onto ${chosen ?? "(unparsed)"} was declined${decision.needs_localization ? " — the goal needs a localization record first" : ""}`);
  const record: DoorRecord = {
    schema: ROUTING_RECORD_SCHEMA, entry: "editIntent", goal,
    is_edit_intent: isEditIntentGoal(goal), is_pathless_code_change: isPathlessCodeChangeGoal(goal),
    resolution: { terms: extractSearchTerms(goal), candidates: [...candidates], chosen_file: chosen, method, reads },
    restated_goal: restatedGoal, ports, llm, decision, fell_back,
  };
  return { goal: decision.goal, record };
}

/** The door as index.ts calls it: resolvePathlessCodeChangeGoal's signature, the dispatch goal back. */
export async function resolveDoorGoal(
  goal: string,
  search: FileSearch,
  tap?: (message: string) => void,
  symbolSearch?: FileSearch,
  proposeSymbols?: (goal: string) => Promise<readonly string[]>,
  readFileText?: (path: string) => Promise<string | undefined>,
): Promise<string> {
  return (await resolveDoorRouting(goal, search, tap, symbolSearch, proposeSymbols, readFileText)).goal;
}

/** A replay read the record does not answer. */
export class UnrecordedPort extends Error {
  constructor(public readonly port: string, public readonly key: string) {
    super(`UnrecordedPort ${port}[${key}]`);
    this.name = "UnrecordedPort";
  }
}

/** The recorded ports as the resolver's search functions. Every miss throws UnrecordedPort. */
export function replayPorts(ports: RoutingPorts, llm: RoutingLlm | null) {
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const search: FileSearch = async (term, scope, callers) => {
    const k = searchKey(term, scope, callers);
    if (!own(ports.search, k)) throw new UnrecordedPort("search", k);
    return ports.search[k]!;
  };
  const symbolSearch: FileSearch = async (word, scope) => {
    const k = symbolKey(word, scope);
    if (!own(ports.symbol_search, k)) throw new UnrecordedPort("symbol_search", k);
    return ports.symbol_search[k]!;
  };
  const proposeSymbols = async (_g: string): Promise<readonly string[]> => {
    if (!llm || llm.propose_symbols === null) throw new UnrecordedPort("llm", "propose_symbols");
    return llm.propose_symbols;
  };
  const readFileText = async (path: string): Promise<string | undefined> => {
    if (!own(ports.read_file, path)) throw new UnrecordedPort("read_file", path);
    return ports.read_file[path] ?? undefined;
  };
  return { search, symbolSearch, proposeSymbols, readFileText };
}

/**
 * THE ENTRY (editIntent): the route production takes for this record, replayed. Door (the pathless resolution over the
 * recorded ports, then decideDoor), then the gap-record hydration, then the hand-off. A port the record does not answer
 * fails the replay. The resolver swallows a throwing search and leaves the goal unrestated, so an unrecorded port is
 * also caught here, after the fact, and rethrown: it can never read as "no file".
 */
export async function routeEditIntent(input: EditIntentInput, ports: RoutingPorts, llm: RoutingLlm | null): Promise<RouteDecision> {
  const p = replayPorts(ports, llm);
  let unrecorded: UnrecordedPort | null = null;
  const guard = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try { return await f(...a); } catch (e) { if (e instanceof UnrecordedPort) unrecorded ??= e; throw e; }
  };
  const { goal, record } = await resolveDoorRouting(
    input.goal, guard(p.search), undefined, guard(p.symbolSearch), guard(p.proposeSymbols), guard(p.readFileText), input.localization,
  );
  if (unrecorded) throw unrecorded;
  const h = handoffRoute({ goal_for_routing: goalForRoutingOf(goal, input.hydration), route_enabled: input.route_enabled });
  // needs_localization is the door's verdict on the goal as written; it is reported even when hydration routes.
  return { route: h.route, target: h.target, needs_localization: record.decision.needs_localization };
}
