/**
 * CLOSED VOCABULARY FOR A SYNTHESIZED WRITE POINTER.
 *
 * A write shape whose owner checks a field against a closed set (a fixed list of
 * names, scoped lists of tokens) says so where the walk can read it: in the shape's
 * advertised description, in a resolver_schema field's enum, and in the refusal it
 * answers when the set is missed ("unknown_<field>: <field>s: a, b"). The pointer
 * synthesizer saw none of it, so a write could be refused three times in a row on
 * a field with exactly one allowed value. This module turns what the shape
 * advertises into a vocabulary and holds a synthesized pointer to it:
 *
 *   - a scalar field gets an allowed value: kept when it matches, mapped when it
 *     names exactly one allowed value, filled when only one value is allowed;
 *   - a list field draws only from its allowed set (order kept, unknowns dropped);
 *   - a closed field that cannot be satisfied refuses the call with a reason,
 *     rather than sending a guess.
 *
 * Prose is read conservatively: vocabulary parsed from a description only corrects
 * or filters a field the pointer already carries (or a schema marks required). A
 * resolver's own refusal is authoritative, so its vocabulary may fill an absent
 * single-valued field. Nothing here names any shape or field: everything is derived
 * from what the shape advertises.
 */

export type VocabSource = "description" | "schema" | "refusal";

export interface FieldVocab {
  /** Allowed values regardless of scope. */
  allowed?: string[];
  /** Allowed values that depend on another field's value: scope field, then value -> allowed. */
  scoped?: { by: string; values: Record<string, string[]> };
  source: VocabSource;
}

export type Vocabulary = Record<string, FieldVocab>;

/** A name or token: letters, digits, "_", "-", "." and inner ":" (never a trailing ":", which ends a label). */
const IDENT = String.raw`[A-Za-z][\w.-]*(?::[\w.-]+)*`;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function splitList(text: string): string[] {
  return text
    .split(/\s*(?:,|\||\bor\b|\band\b)\s*/)
    .map((s) => s.trim().replace(/^["'`]+|["'`.]+$/g, ""))
    .filter((s) => new RegExp(`^${IDENT}$`).test(s));
}

function addAllowed(v: Vocabulary, field: string, values: string[], source: VocabSource): void {
  if (values.length === 0) return;
  const cur = v[field] ?? { source };
  cur.allowed = [...new Set([...(cur.allowed ?? []), ...values])];
  v[field] = cur;
}

/**
 * The vocabulary a shape's description advertises, for the fields `fields` names (the
 * keys of the pointer being checked, plus any schema fields). Two forms are read:
 *   "<field> is one of a, b, c" (also "must be one of", "one of: a|b|c");
 *   "<field> <value>: <listField> a, b, c; ..." — a scoped clause: <field> allows each
 *   <value> such clauses name, and under it <listField> allows the listed tokens.
 * A form naming a word that is not one of `fields` is ignored.
 */
export function vocabularyFromDescription(description: string, fields: readonly string[]): Vocabulary {
  const v: Vocabulary = {};
  if (!description || fields.length === 0) return v;
  const known = new Set(fields);
  // "<field> (is|must be|should be)? one of <list>" up to the end of the clause.
  for (const m of description.matchAll(new RegExp(String.raw`\b(${IDENT})\s+(?:is\s+|must\s+be\s+|should\s+be\s+)?one\s+of\s*:?\s*([^;.()]+)`, "gi"))) {
    const field = m[1]!;
    if (!known.has(field)) continue;
    addAllowed(v, field, splitList(m[2]!), "description");
  }
  // Scoped clauses, each starting a sentence or following ";": "<field> <value>: <rest>".
  for (const m of description.matchAll(new RegExp(String.raw`(?<=^|[.;]\s+)(${IDENT})\s+(${IDENT}):\s+([^.;]+)`, "g"))) {
    const field = m[1]!, value = m[2]!, rest = m[3]!;
    if (!known.has(field)) continue;
    const lm = rest.match(new RegExp(String.raw`^(${IDENT})\s+(${IDENT}(?:\s*,\s*${IDENT})*)\s*$`));
    if (!lm || !known.has(lm[1]!) || lm[1] === field) continue;
    addAllowed(v, field, [value], "description");
    const listField = lm[1]!;
    const cur = v[listField] ?? { source: "description" as VocabSource };
    const scoped = cur.scoped && cur.scoped.by === field ? cur.scoped : { by: field, values: {} as Record<string, string[]> };
    scoped.values[value] = splitList(lm[2]!);
    cur.scoped = scoped;
    v[listField] = cur;
  }
  return v;
}

/** The vocabulary a resolver_schema advertises: fields carrying an `enum` (or `allowed`) array. */
export function vocabularyFromSchema(fields: unknown): Vocabulary {
  const v: Vocabulary = {};
  if (!Array.isArray(fields)) return v;
  for (const f of fields as Array<Record<string, unknown>>) {
    const name = typeof f?.["name"] === "string" ? (f["name"] as string) : "";
    const vals = Array.isArray(f?.["enum"]) ? f["enum"] : Array.isArray(f?.["allowed"]) ? f["allowed"] : null;
    if (name && vals) addAllowed(v, name, (vals as unknown[]).filter((x): x is string => typeof x === "string"), "schema");
  }
  return v;
}

/**
 * The vocabulary a refusal names: "unknown_<field>" (or "invalid_<field>") followed by
 * "<label>: a, b" where <label> is the field, its plural, or the list it belongs to.
 * Returns null when the body names no allowed values.
 */
export function vocabularyFromRefusal(body: string): { field: string; allowed: string[] } | null {
  if (!body) return null;
  const code = body.match(/\b(?:unknown|invalid|unsupported)_([a-z][a-z0-9_]*)\b/i);
  if (!code) return null;
  const field = code[1]!;
  const f = esc(field);
  const m = body.match(new RegExp(String.raw`\b(?:${f}|${f}s|${f}es):\s*(${IDENT}(?:\s*(?:,|\|)\s*${IDENT})*)`, "i"));
  const allowed = m ? splitList(m[1]!) : [];
  return allowed.length ? { field, allowed } : null;
}

/** Merge vocabularies; later ones add to earlier ones. */
export function mergeVocabularies(...vs: Vocabulary[]): Vocabulary {
  const out: Vocabulary = {};
  for (const v of vs) {
    for (const [k, fv] of Object.entries(v)) {
      const cur = out[k] ?? { source: fv.source };
      if (fv.allowed) cur.allowed = [...new Set([...(cur.allowed ?? []), ...fv.allowed])];
      if (fv.scoped) cur.scoped = cur.scoped && cur.scoped.by === fv.scoped.by ? { by: fv.scoped.by, values: { ...cur.scoped.values, ...fv.scoped.values } } : fv.scoped;
      if (fv.source === "refusal" || fv.source === "schema") cur.source = fv.source;
      out[k] = cur;
    }
  }
  return out;
}

/** Map a refusal's field to the pointer key that carries it ("block" -> "blocks"). */
export function refusalVocabulary(body: string, pointerKeys: readonly string[]): Vocabulary {
  const r = vocabularyFromRefusal(body);
  if (!r) return {};
  const keys = new Set(pointerKeys);
  const key = [r.field, `${r.field}s`, `${r.field}es`].find((k) => keys.has(k)) ?? r.field;
  return { [key]: { allowed: r.allowed, source: "refusal" } };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** The allowed value `value` names: exact, normalized, or the one allowed value whose words it contains. */
function matchAllowed(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  if (allowed.includes(value)) return value;
  const n = norm(value);
  if (!n) return null;
  const exact = allowed.filter((a) => norm(a) === n);
  if (exact.length === 1) return exact[0]!;
  const contained = allowed.filter((a) => { const na = norm(a); return na.length > 0 && `_${n}_`.includes(`_${na}_`); });
  return contained.length === 1 ? contained[0]! : null;
}

export interface ConstrainResult {
  pointer: Record<string, unknown>;
  /** One line per field changed: "<field>: <before> -> <after>". */
  changes: string[];
  /** Set when a closed field cannot be satisfied; the call must not be made. */
  refused: string | null;
}

function constrainLevel(p: Record<string, unknown>, vocab: Vocabulary, required: ReadonlySet<string>, changes: string[]): string | null {
  // Scalar (and scope) fields first, so a scoped list reads its scope's corrected value.
  const order = Object.keys(vocab).sort((a, b) => Number(!!vocab[a]!.scoped) - Number(!!vocab[b]!.scoped));
  for (const field of order) {
    const fv = vocab[field]!;
    const present = field in p && p[field] !== undefined && p[field] !== null;
    // Prose may describe a default the owner falls back to, so a description alone never refuses: it
    // corrects and filters. A schema or the resolver's own refusal is the owner's check, and refuses.
    const authoritative = fv.source !== "description" || required.has(field);
    let allowed = fv.allowed ?? [];
    if (fv.scoped) {
      const scopeVal = p[fv.scoped.by];
      const scopedAllowed = typeof scopeVal === "string" ? fv.scoped.values[scopeVal] : undefined;
      if (scopedAllowed) allowed = [...new Set([...allowed, ...scopedAllowed])];
      else if (!fv.allowed) {
        if (present || required.has(field)) {
          const all = [...new Set(Object.values(fv.scoped.values).flat())];
          if (all.length === 0) continue;
          allowed = all;
        } else continue;
      }
    }
    if (allowed.length === 0) continue;
    if (!present) {
      if (allowed.length === 1 && authoritative && !fv.scoped) {
        p[field] = allowed[0]!;
        changes.push(`${field}: (absent) -> ${allowed[0]}`);
        continue;
      }
      if (required.has(field)) return `required closed field "${field}" is absent and the shape allows ${allowed.join(", ")}: no single value to choose`;
      continue;
    }
    const cur = p[field];
    if (Array.isArray(cur)) {
      const kept: string[] = [];
      const dropped: string[] = [];
      for (const item of cur) {
        const m = matchAllowed(item, allowed);
        if (m && !kept.includes(m)) kept.push(m);
        else if (!m) dropped.push(String(item));
      }
      if (kept.length === 0 && !authoritative) continue;
      if (kept.length === 0) return `closed list field "${field}" names none of the allowed values (${allowed.join(", ")}): ${JSON.stringify(cur).slice(0, 160)}`;
      if (JSON.stringify(kept) !== JSON.stringify(cur)) {
        p[field] = kept;
        changes.push(`${field}: ${JSON.stringify(cur).slice(0, 120)} -> ${JSON.stringify(kept)}${dropped.length ? ` (dropped ${dropped.join(", ").slice(0, 120)})` : ""}`);
      }
      continue;
    }
    if (typeof cur === "string" && !fv.scoped) {
      const m = matchAllowed(cur, allowed) ?? (allowed.length === 1 ? allowed[0]! : null);
      if (m === null && !authoritative) continue;
      if (m === null) return `closed field "${field}" value ${JSON.stringify(cur).slice(0, 80)} is not one of ${allowed.join(", ")}`;
      if (m !== cur) {
        p[field] = m;
        changes.push(`${field}: ${JSON.stringify(cur).slice(0, 80)} -> ${m}`);
      }
    }
  }
  return null;
}

/**
 * Hold `pointer` to `vocab`. The pointer's top level is checked, and so is each direct
 * child object that carries a vocabulary field (an enveloped write puts its args under
 * one key). Returns a copy; the input is not modified.
 */
export function constrainPointer(pointer: Record<string, unknown>, vocab: Vocabulary, required: readonly string[] = []): ConstrainResult {
  const out: Record<string, unknown> = { ...pointer };
  const changes: string[] = [];
  if (Object.keys(vocab).length === 0) return { pointer: out, changes, refused: null };
  const req = new Set(required);
  const fields = Object.keys(vocab);
  const nested = Object.entries(out).filter(([, val]) => val && typeof val === "object" && !Array.isArray(val) && fields.some((f) => f in (val as Record<string, unknown>)));
  if (nested.length > 0 && !fields.some((f) => f in out)) {
    for (const [k, val] of nested) {
      const inner = { ...(val as Record<string, unknown>) };
      const refused = constrainLevel(inner, vocab, req, changes);
      if (refused) return { pointer: out, changes, refused };
      out[k] = inner;
    }
    return { pointer: out, changes, refused: null };
  }
  const refused = constrainLevel(out, vocab, req, changes);
  return { pointer: out, changes, refused };
}

/** The pointer keys a vocabulary is read for: the top level plus one envelope level. */
export function pointerFieldNames(pointer: Record<string, unknown>): string[] {
  const names = new Set(Object.keys(pointer));
  for (const val of Object.values(pointer)) {
    if (val && typeof val === "object" && !Array.isArray(val)) for (const k of Object.keys(val as Record<string, unknown>)) names.add(k);
  }
  return [...names];
}

/**
 * The first balanced JSON object in a model's reply, parsed. `//` and `/* *\/` comments
 * outside strings and trailing commas are removed first; anything still invalid is
 * refused with a reason, so only valid JSON is ever sent as pointer args.
 */
export function parseJsonObjectLenient(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start < 0) return { ok: false, reason: "the reply carries no JSON object" };
  let depth = 0, inStr = false, esc = false, end = -1;
  let cleaned = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      cleaned += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cleaned += c; continue; }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; cleaned += "\n"; continue; }
    if (c === "/" && s[i + 1] === "*") { const j = s.indexOf("*/", i + 2); i = j < 0 ? s.length : j + 1; continue; }
    cleaned += c;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return { ok: false, reason: "the reply's JSON object is not closed" };
  try {
    let v: unknown;
    try { v = JSON.parse(cleaned); } catch { v = JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1")); }
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "the reply's JSON is not an object" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    return { ok: false, reason: `the synthesized args were not valid JSON: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
}

/** What a write shape advertises, as the walk holds it when it builds the pointer. */
export interface WriteAdvertisement {
  /** The shape's description from discovery, if any. */
  description?: string | null;
  /** resolver_schema fields (name, required, enum), if the owner serves a schema. */
  schemaFields?: unknown;
  /** Vocabulary this walk learned from the shape's own refusals. */
  learned?: Vocabulary;
}

function schemaRequired(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  return (fields as Array<Record<string, unknown>>).filter((f) => f?.["required"] === true && typeof f["name"] === "string").map((f) => f["name"] as string);
}

/**
 * Hold a write pointer to what its shape advertises. The pointer's own `type` is the shape
 * name the resolve protocol carries, never a field of the write, so it is left out of the
 * check and put back unchanged.
 */
export function holdWriteToAdvertised(pointer: Record<string, unknown>, ad: WriteAdvertisement): ConstrainResult & { vocabulary: Vocabulary } {
  const { type: shapeType, ...rest } = pointer;
  const names = [...new Set([...pointerFieldNames(rest), ...(Array.isArray(ad.schemaFields) ? (ad.schemaFields as Array<Record<string, unknown>>).map((f) => String(f?.["name"] ?? "")).filter(Boolean) : [])])];
  const vocabulary = mergeVocabularies(
    vocabularyFromDescription(ad.description ?? "", names),
    vocabularyFromSchema(ad.schemaFields),
    ad.learned ?? {},
  );
  const r = constrainPointer(rest, vocabulary, schemaRequired(ad.schemaFields));
  const out = shapeType === undefined ? r.pointer : { type: shapeType, ...r.pointer };
  return { pointer: out, changes: r.changes, refused: r.refused, vocabulary };
}

/**
 * A write refused with a body naming the allowed values: the vocabulary it teaches, and the
 * pointer held to it. `retry` is true only when the repair changed the pointer and nothing
 * refused, so a caller retries at most once and never resends the same pointer.
 */
export function repairFromRefusal(pointer: Record<string, unknown>, refusalBody: string, ad: WriteAdvertisement): { learned: Vocabulary; retry: boolean } & ConstrainResult {
  const { type: _t, ...rest } = pointer;
  const taught = refusalVocabulary(refusalBody, pointerFieldNames(rest));
  if (Object.keys(taught).length === 0) return { learned: ad.learned ?? {}, retry: false, pointer, changes: [], refused: null };
  const learned = mergeVocabularies(ad.learned ?? {}, taught);
  const held = holdWriteToAdvertised(pointer, { ...ad, learned });
  return { learned, retry: !held.refused && held.changes.length > 0, pointer: held.pointer, changes: held.changes, refused: held.refused };
}

/**
 * A cached reader of discovery's shape descriptions (GET <url> -> {shape_descriptions}).
 * Fail-open: an unreachable or malformed answer yields no description, and the last good
 * map is kept.
 */
export function createDescriptionReader(url: string, ttlMs: number, fetchImpl: typeof fetch = fetch): (shape: string) => Promise<string | null> {
  let cache: { map: Record<string, string>; at: number } | null = null;
  return async (shape: string) => {
    if (!cache || Date.now() - cache.at >= ttlMs) {
      try {
        const r = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const j = (await r.json()) as { shape_descriptions?: unknown };
          const m = j?.shape_descriptions;
          if (m && typeof m === "object" && !Array.isArray(m)) cache = { map: m as Record<string, string>, at: Date.now() };
        }
      } catch { /* fail-open: keep the last good map */ }
      // A failed refresh waits a full TTL too, so an unreachable registry costs one timeout per TTL, not per write.
      if (!cache || Date.now() - cache.at >= ttlMs) cache = { map: cache?.map ?? {}, at: Date.now() };
    }
    const d = cache?.map[shape];
    return typeof d === "string" ? d : null;
  };
}

/**
 * The one repaired resend after a refused write. Only a 422 is read; `send` is called at most
 * once, and only when the refusal named allowed values that changed the pointer. Returns the
 * resend's status and body when it was made, the vocabulary learned either way, and a line
 * saying what happened (null when the refusal taught nothing).
 */
export async function repairAndResendOnce(
  pointer: Record<string, unknown>,
  status: number,
  refusalBody: string,
  ad: WriteAdvertisement,
  send: (p: Record<string, unknown>) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>,
): Promise<{ learned: Vocabulary; resent: { pointer: Record<string, unknown>; status: number; ok: boolean; bodyText: string; response: unknown } | null; note: string | null }> {
  if (status !== 422) return { learned: ad.learned ?? {}, resent: null, note: null };
  const rep = repairFromRefusal(pointer, refusalBody, ad);
  if (rep.refused) return { learned: rep.learned, resent: null, note: `the refusal's allowed values cannot satisfy the pointer — ${rep.refused}; not retrying` };
  if (!rep.retry) return { learned: rep.learned, resent: null, note: null };
  const r = await send(rep.pointer);
  return { learned: rep.learned, resent: { pointer: rep.pointer, status: r.status, ok: r.ok, bodyText: await r.text(), response: r }, note: `HTTP 422 named the allowed values — repaired once and resent: ${rep.changes.join("; ")}` };
}
