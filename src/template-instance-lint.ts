// A TEMPLATE'S TASKS MUST CARRY SLOTS, NOT THE INSTANCE THEY WERE EXTRACTED FROM.
//
// Gap minted-templates-replay-instance-values-because-reach-to-mint-bakes-the-original-goals-record-ids-and-nouns-into-
// their-tasks. A reach is extracted into a learned template by the ribosome (ribosome-extract, an LLM synthesis over the
// trace). Measured on two minted memoryNote_write compositions: a write task's config carried the original note's title
// and body as literals, the source dispatch's id, whole upstream impulse payloads inlined under their shape's name
// (where a {{impulse:<shape>}} slot belongs), and an object KEY built from the goal sentence. Replaying such a template
// on a new goal re-writes the old record. This lint names those instance values so a selection can refuse the template
// (and the producer, ribosome-extract's write contract, can refuse to write it).
//
// Two kinds of signal, both read from the template alone:
//   - STRUCTURAL: a literal where a slot belongs (a run id; an inlined impulse payload; a content field of a write task
//     with no {{...}} in it; a goal-derived key);
//   - INSTANCE VALUES the caller knows (the reach's record ids, its goal's nouns and slugs), anywhere in a key or value.
// A string that carries a {{...}} slot is a slot, never an instance value. Only `config` and `pointer` are read
// structurally; a task's prose (`description`) is checked against the given instance values only.

export type InstanceLintFinding = { taskId: string; path: string; kind: "run-id" | "inlined-impulse" | "write-content-literal" | "goal-derived-key" | "instance-value"; detail: string };

const SLOT = /\{\{[^}]+\}\}/;
/** Keys whose literal value names one run (a dispatch, an execution, a trace). */
const RUN_ID_KEYS = new Set(["dispatch_id", "dispatchId", "execution_id", "executionId", "trace_id", "traceId", "request_id", "lease_id"]);
/** A write task's content fields: on a *_write resolver, a literal here is the original record. */
const WRITE_CONTENT_KEYS = new Set(["title", "body", "content", "text", "note", "summary", "path"]);
/** A key that is a sentence: at least five underscore- or dash-joined words, or longer than 32 characters with three. */
function goalDerivedKey(k: string): boolean {
  const words = k.split(/[_\-]+/).filter((w) => w.length > 0);
  return words.length >= 5 || (k.length > 32 && words.length >= 3);
}
/** An object that is an impulse's payload (what a step produced), not a configuration. */
function isImpulsePayload(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o["shape"] === "string" && ("success" in o || "body" in o || "exit_code" in o || "stdout" in o);
}

function taskResolver(t: Record<string, unknown>): string {
  return String(t["resolver"] ?? t["resolverId"] ?? (t["config"] as Record<string, unknown> | undefined)?.["type"] ?? "");
}

/** Every instance value the template's tasks carry; empty means the tasks are slot/shape-level. */
export function lintTemplateInstanceValues(template: unknown, instanceValues: readonly string[] = []): InstanceLintFinding[] {
  const tasks = (template && typeof template === "object" ? (template as { tasks?: unknown }).tasks : undefined);
  if (!Array.isArray(tasks)) return [];
  const needles = [...new Set(instanceValues.map((v) => String(v).trim()).filter((v) => v.length >= 4))].map((v) => [v, v.toLowerCase()] as const);
  const out: InstanceLintFinding[] = [];
  const hit = (s: string) => { const l = s.toLowerCase(); return needles.find(([, n]) => l.includes(n))?.[0]; };
  tasks.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const t = raw as Record<string, unknown>;
    const taskId = String(t["id"] ?? t["taskId"] ?? `#${i}`);
    const isWrite = /_write$/.test(taskResolver(t));
    const walk = (v: unknown, path: string, depth: number) => {
      if (depth > 8) return;
      if (typeof v === "string") {
        if (SLOT.test(v)) return;
        const n = hit(v);
        if (n) out.push({ taskId, path, kind: "instance-value", detail: `carries "${n.slice(0, 40)}"` });
        return;
      }
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { v.forEach((x, j) => walk(x, `${path}[${j}]`, depth + 1)); return; }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const p = `${path}.${k}`;
        const kn = hit(k);
        if (kn) out.push({ taskId, path: p, kind: "instance-value", detail: `key carries "${kn.slice(0, 40)}"` });
        else if (goalDerivedKey(k)) out.push({ taskId, path: p, kind: "goal-derived-key", detail: `key of ${k.length} chars` });
        if (typeof val === "string" && !SLOT.test(val)) {
          if (RUN_ID_KEYS.has(k) && val.length > 0) { out.push({ taskId, path: p, kind: "run-id", detail: "a literal run id" }); continue; }
          if (isWrite && depth === 0 && WRITE_CONTENT_KEYS.has(k) && val.trim().length > 0) { out.push({ taskId, path: p, kind: "write-content-literal", detail: `a literal ${k} on a write task` }); continue; }
        }
        if (isImpulsePayload(val)) { out.push({ taskId, path: p, kind: "inlined-impulse", detail: `an inlined ${String((val as Record<string, unknown>)["shape"])} payload` }); continue; }
        walk(val, p, depth + 1);
      }
    };
    for (const key of ["config", "pointer"]) if (t[key] !== undefined) walk(t[key], `${taskId}.${key}`, 0);
    if (needles.length > 0 && typeof t["description"] === "string") {
      const n = hit(t["description"] as string);
      if (n) out.push({ taskId, path: `${taskId}.description`, kind: "instance-value", detail: `carries "${n.slice(0, 40)}"` });
    }
  });
  return out;
}

/** Whether a template may be replayed on a new goal: no instance value in its tasks. */
export function templateIsSlotLevel(template: unknown, instanceValues: readonly string[] = []): boolean {
  return lintTemplateInstanceValues(template, instanceValues).length === 0;
}
