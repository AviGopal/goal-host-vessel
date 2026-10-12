// THE LOCALIZATION RECORD VALIDATOR (closed). A shaped `localizationRecord` impulse names the file a need is about and
// the evidence it is the site. The schema is test/routing-corpus/localization-record.schema.json; this is its run-time
// check, pinned against the schema by test/routing-corpus/localization-record.test.ts. The routing core hands a record
// to the open rules only when it passes, so "a file edit needs a valid localization record" cannot be met by a
// malformed or evidence-free record.
import type { LocalizationRecord } from "./types";

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const KEYS = new Set(["gap_id", "dispatch_id", "file", "evidence", "method", "created_at"]);

export function validLocalizationRecord(v: unknown): v is LocalizationRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !KEYS.has(k))) return false;
  if (!str(r.gap_id) && !str(r.dispatch_id)) return false;
  if (r.gap_id !== undefined && !str(r.gap_id)) return false;
  if (r.dispatch_id !== undefined && !str(r.dispatch_id)) return false;
  if (!str(r.file) || !/^repos\/[\w.-]+\/[\w.\/-]+\.\w+$/.test(r.file)) return false;
  if (!str(r.method) || !str(r.created_at) || Number.isNaN(Date.parse(r.created_at))) return false;
  if (!Array.isArray(r.evidence) || r.evidence.length === 0) return false;
  return r.evidence.every((e) => !!e && typeof e === "object" && !Array.isArray(e) && Object.keys(e).every((k) => k === "read" || k === "why") && str((e as { read?: unknown }).read) && str((e as { why?: unknown }).why));
}
