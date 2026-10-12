// THE CAPTURED -> REPLAY ADAPTER (closed): a captured editIntent routing record (src/judge/capture.ts routing_input)
// becomes the input, ports and recorded model output routeEditIntent replays.
//
// NEVER A DEFAULT. A field the replay needs that the record does not carry, or carries as null where null is not a
// value, makes the record UNREPLAYABLE, with every such field named. A guessed value would replay a decision production
// never took, and a held-out comparison on it would vouch for nothing. The replay needs:
//   - goal (non-empty) and route_enabled (boolean): the hand-off reads both;
//   - localization (present; null = no record): the door reads it;
//   - gap_hint: null = no hydration; applied:false = the cited file was not put on the goal (no hydration);
//     applied:true needs cited_file and summary (the hand-off reads the summary's text);
//   - resolution.candidates: each search answer with hits (an errored search cannot be replayed as an answer), and
//     each term search's prefer_call_sites flag (the search is keyed by it);
//   - resolution.reads: each read's whole text (the comment check reads it); an unreadable read is text null, and a
//     read cut to the capture's cap (capped:true) is unreplayable.
// Field names are the canonical routing record's (src/judge/records.ts RoutingInputRecord / RoutingResolution).
// Records already in the replay form (the corpus case input with its ports) pass through the same required-field check.
import type { EditIntentInput, RoutingLlm, RoutingPorts } from "./types";

export type ReplayAdapted = { ok: true; input: EditIntentInput; ports: RoutingPorts; llm: RoutingLlm | null } | { ok: false; unreplayable: string[] };

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function editIntentReplayOf(record: unknown, ports?: unknown, llm?: unknown): ReplayAdapted {
  const missing: string[] = [];
  if (!isObj(record)) return { ok: false, unreplayable: ["input"] };
  const r = record;
  if (r.schema !== 1) missing.push("schema");
  if (r.entry !== "editIntent") missing.push("entry");
  if (typeof r.goal !== "string" || r.goal.length === 0) missing.push("goal");
  if (typeof r.route_enabled !== "boolean") missing.push("route_enabled");
  if (!has(r, "localization")) missing.push("localization");
  if (r.capped === true) missing.push("capped");

  // Already in the replay form: the case input and its recorded ports.
  if (!has(r, "resolution")) {
    if (!has(r, "hydration")) missing.push("hydration");
    if (!isObj(ports) || !isObj(ports.search) || !isObj(ports.symbol_search) || !isObj(ports.read_file)) missing.push("ports");
    if (missing.length) return { ok: false, unreplayable: missing };
    return { ok: true, input: r as unknown as EditIntentInput, ports: ports as RoutingPorts, llm: (isObj(llm) ? llm : null) as RoutingLlm | null };
  }

  // A captured routing_input record.
  let hydration: EditIntentInput["hydration"] = null;
  if (!has(r, "gap_hint")) missing.push("gap_hint");
  else if (r.gap_hint !== null) {
    const h = r.gap_hint;
    if (!isObj(h) || typeof h.applied !== "boolean") missing.push("gap_hint.applied");
    else if (h.applied) {
      if (typeof h.cited_file !== "string" || !h.cited_file) missing.push("gap_hint.cited_file");
      if (typeof h.summary !== "string") missing.push("gap_hint.summary");
      if (typeof h.cited_file === "string" && typeof h.summary === "string") hydration = { cited_file: h.cited_file, summary: h.summary };
    }
  }
  const out: RoutingPorts = { search: {}, symbol_search: {}, read_file: {} };
  let propose = null as string[] | null;
  const res = r.resolution;
  if (!isObj(res)) missing.push("resolution");
  else {
    const cands = Array.isArray(res.candidates) ? res.candidates : null;
    if (!cands) missing.push("resolution.candidates");
    (cands ?? []).forEach((c, i) => {
      const at = `resolution.candidates[${i}]`;
      if (!isObj(c)) { missing.push(at); return; }
      if (c.error === true) { missing.push(`${at}.error`); return; }
      if (!Array.isArray(c.hits) || !c.hits.every((h) => typeof h === "string")) { missing.push(`${at}.hits`); return; }
      const scope = c.scope === null || c.scope === undefined ? "*" : String(c.scope);
      if (c.via === "term") {
        if (typeof c.prefer_call_sites !== "boolean") { missing.push(`${at}.prefer_call_sites`); return; }
        out.search[`${scope}|${c.prefer_call_sites ? 1 : 0}|${String(c.term)}`] = c.hits as string[];
      } else if (c.via === "symbol") {
        out.symbol_search[`${scope}|${String(c.term)}`] = c.hits as string[];
      } else if (c.via === "proposal") {
        propose = c.hits as string[];
      } else missing.push(`${at}.via`);
    });
    const reads = Array.isArray(res.reads) ? res.reads : null;
    if (!reads) missing.push("resolution.reads");
    (reads ?? []).forEach((rd, i) => {
      const at = `resolution.reads[${i}]`;
      if (!isObj(rd) || typeof rd.path !== "string") { missing.push(`${at}.path`); return; }
      if (rd.readable === false) { out.read_file[rd.path] = null; return; }
      if (rd.capped === true) { missing.push(`${at}.capped`); return; }
      if (typeof rd.text !== "string") { missing.push(`${at}.text`); return; }
      out.read_file[rd.path] = rd.text;
    });
  }
  if (missing.length) return { ok: false, unreplayable: missing };
  const input: EditIntentInput = { schema: 1, entry: "editIntent", goal: r.goal as string, route_enabled: r.route_enabled as boolean, hydration, localization: r.localization };
  return { ok: true, input, ports: out, llm: propose === null ? null : { propose_symbols: propose } };
}
