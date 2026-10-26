// THE RUN DOOR AND THE DISPATCH'S REFUSALS (write-door.ts templateRunRefused, DoorRefusals).
// Measured: a read question's template_pick door dropped learned-composition-test-suite-to-substrategap-write twice;
// the composite author then returned the same template as an existing composite with outputs [test_suite], the
// composite door judged only those outputs, and the template ran. Here a stub walk runs a pick only when the door
// passes it, and counts the write tasks it would have executed.
// The module is imported per test, so a missing export fails that test by name rather than the whole file.
import { beforeEach, describe, expect, it } from "bun:test";

type Door = typeof import("./write-door");
const door = async (): Promise<Door> => {
  const m = await import("./write-door");
  expect(typeof (m as Partial<Door>).templateRunRefused).toBe("function");
  expect(typeof (m as Partial<Door>).DoorRefusals).toBe("function");
  return m;
};

const ID = "learned-composition-test-suite-to-substrategap-write";
const WRAPPED = `activity:⟨${ID}⟩`;
const GAP_WRITING = {
  id: ID,
  output_shapes: ["test_suite"],
  tasks: [
    { id: "t1", resolver: "test_suite", outputShapes: ["test_suite"] },
    { id: "t2", resolver: "substrateGap_write", outputShapes: ["substrateGap_write"] },
  ],
};
const READ_ONLY = {
  id: "learned-composition-test-suite-to-llm-completion",
  output_shapes: ["llm_completion"],
  tasks: [
    { id: "t1", resolver: "test_suite", outputShapes: ["test_suite"] },
    { id: "t2", resolver: "llm_completion", outputShapes: ["llm_completion"] },
  ],
};

/** The stub walk's execute step: run the pick unless the door refuses it; the write tasks it ran. */
async function runPick(m: Door, pick: { id: string; outputShapes: string[] }, template: typeof GAP_WRITING, admitted: boolean, refused: ReturnType<InstanceType<Door["DoorRefusals"]>["forDispatch"]>, lines: string[], product: Set<string> = new Set()): Promise<{ ran: boolean; writeTasks: number }> {
  if (await m.templateRunRefused(pick.id, pick.outputShapes, async () => template, admitted, "composite_pick", refused, "h1", (l) => lines.push(l), product)) return { ran: false, writeTasks: 0 };
  return { ran: true, writeTasks: template.tasks.filter((t) => m.refusedWrite(t.resolver, product)).length };
}

describe("the run door judges what a template writes", () => {
  beforeEach(async () => (await import("./write-door")).resetWriteDoorCounters());

  it("[MUST-FAIL] a read goal's only composition, declaring [test_suite] with a substrateGap_write task, runs 0 write tasks and is refused at composite_pick", async () => {
    const m = await door();
    const lines: string[] = [];
    const refused = new m.DoorRefusals().forDispatch("dispatch-a");
    const r = await runPick(m, { id: WRAPPED, outputShapes: ["test_suite"] }, GAP_WRITING, false, refused, lines);
    expect(r).toEqual({ ran: false, writeTasks: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[write-door] dropped ${ID}: goal not admitted as a change (door=composite_pick`);
    expect(m.writeDoorCounters().composite_pick).toBe(1);
    expect(refused.has(ID)).toBe(true);
  });

  it("[MUST-FAIL] a template dropped at template_pick and re-offered by the composite author is refused again", async () => {
    const m = await door();
    const lines: string[] = [];
    const refusals = new m.DoorRefusals();
    const refused = refusals.forDispatch("dispatch-b");
    // the template_pick door drops the discovery row (which names the write), and the walk notes the drop
    const rows = [{ id: ID, outputShapes: ["test_suite", "substrateGap_write"] }, { id: "reader", outputShapes: ["test_suite"] }];
    const kept = m.writeDoorFilter(rows, (c) => c.outputShapes, false, "template_pick", "h1", (l) => lines.push(l), (c) => c.id);
    refused.noteDropped(rows, kept, (c) => c.id);
    expect(kept.map((c) => c.id)).toEqual(["reader"]);
    // a retry walk of the SAME dispatch gets the same record; the composite author re-offers the template wrapped,
    // and even a template whose tasks no longer show the write is refused by the dispatch's record
    const again = refusals.forDispatch("dispatch-b");
    const r = await runPick(m, { id: WRAPPED, outputShapes: ["test_suite"] }, READ_ONLY as typeof GAP_WRITING, false, again, lines);
    expect(r.ran).toBe(false);
    expect(lines.at(-1)).toContain(`dropped ${ID}: goal not admitted as a change (door=composite_pick`);
    expect(lines.at(-1)).toContain("already refused in this dispatch");
    expect(m.writeDoorCounters().composite_pick).toBe(1);
  });

  it("the record is per dispatch, and taken at the terminal record", async () => {
    const m = await door();
    const refusals = new m.DoorRefusals();
    refusals.forDispatch("dispatch-c").add(WRAPPED);
    expect(refusals.forDispatch("dispatch-c").has(ID)).toBe(true);
    expect(refusals.forDispatch("dispatch-d").has(ID)).toBe(false);
    refusals.take("dispatch-c");
    expect(refusals.forDispatch("dispatch-c").has(ID)).toBe(false);
    // no dispatch id: a fresh record each time, never shared
    refusals.forDispatch("").add(ID);
    expect(refusals.forDispatch("").has(ID)).toBe(false);
  });

  it("CONTROL: a goal admitted as a change still runs the same composition, write task included", async () => {
    const m = await door();
    const lines: string[] = [];
    const refused = new m.DoorRefusals().forDispatch("dispatch-e");
    refused.add(ID); // even one a door refused before admission was known
    const r = await runPick(m, { id: WRAPPED, outputShapes: ["test_suite"] }, GAP_WRITING, true, refused, lines);
    expect(r).toEqual({ ran: true, writeTasks: 1 });
    expect(lines).toEqual([]);
  });

  it("CONTROL: a read-only composition still runs for a read goal, and is not recorded as refused", async () => {
    const m = await door();
    const lines: string[] = [];
    const refused = new m.DoorRefusals().forDispatch("dispatch-f");
    const r = await runPick(m, { id: READ_ONLY.id, outputShapes: ["llm_completion"] }, READ_ONLY as typeof GAP_WRITING, false, refused, lines);
    expect(r).toEqual({ ran: true, writeTasks: 0 });
    expect(lines).toEqual([]);
    expect(refused.list()).toEqual([]);
  });

  it("CONTROL: a store write that IS the goal's product still runs", async () => {
    const m = await door();
    const lines: string[] = [];
    const refused = new m.DoorRefusals().forDispatch("dispatch-g");
    const r = await runPick(m, { id: ID, outputShapes: ["test_suite"] }, GAP_WRITING, false, refused, lines, new Set(["substrateGap_write"]));
    expect(r.ran).toBe(true);
    expect(lines).toEqual([]);
  });

  it("an unloadable template is judged by its declared outputs, and the line says its tasks were unjudged", async () => {
    const m = await door();
    const lines: string[] = [];
    const refused = new m.DoorRefusals().forDispatch("dispatch-h");
    const ok = await m.templateRunRefused(ID, ["test_suite"], async () => { throw new Error("not found"); }, false, "composite_pick", refused, "h1", (l) => lines.push(l));
    expect(ok).toBe(false);
    expect(lines[0]).toContain(`composite_pick: ${ID} tasks unjudged: template unloadable (not found)`);
    const no = await m.templateRunRefused("w", ["substrateGap_write"], async () => { throw new Error("x"); }, false, "composite_pick", refused, "h1", (l) => lines.push(l));
    expect(no).toBe(true);
  });
});

// THE WRITE A FETCH CARRIES (write-door.ts fetchedResolveWrites): an http_fetch POST of an impulse to a resolve URL
// writes that impulse's type, exactly like a native task of the type; an opaque resolve POST is a write (fail closed).
describe("an http_fetch POST to a resolve URL is judged as the write it carries", () => {
  beforeEach(async () => (await import("./write-door")).resetWriteDoorCounters());
  const fetchTask = (config: Record<string, unknown>) => ({ id: "post", resolver: "http_fetch", config: { type: "http_fetch", ...config }, outputShapes: ["http_fetch"] });
  const composition = (task: unknown) => ({ id: "learned-composition-test-suite-to-http-fetch", output_shapes: ["test_suite"], tasks: [{ id: "t1", resolver: "test_suite", outputShapes: ["test_suite"] }, task] });
  const GAP_POST = fetchTask({ url: "http://127.0.0.1:8090/v2/impulses/resolve", method: "POST", body: JSON.stringify({ impulse: { type: "substrateGap_write", pointer: { type: "substrateGap_write", summary: "x" } } }) });
  const judge = async (m: Door, template: unknown, admitted = false, product: Set<string> = new Set()) => {
    const lines: string[] = [];
    const refused = await m.templateRunRefused("activity:⟨learned-composition-test-suite-to-http-fetch⟩", ["test_suite"], async () => template, admitted, "composite_pick", new m.DoorRefusals().forDispatch("d"), "h1", (l) => lines.push(l), product);
    return { refused, lines };
  };

  it("[MUST-FAIL] a read goal's composition whose http_fetch POSTs {impulse:{type:substrateGap_write}} to a resolve URL is refused at the door", async () => {
    const m = await door();
    expect(m.templateRunShapes(composition(GAP_POST))).toContain("substrateGap_write");
    const r = await judge(m, composition(GAP_POST));
    expect(r.refused).toBe(true);
    expect(r.lines[0]).toContain("door=composite_pick");
    // the body as an object, in config.pointer, and the type only on the pointer are the same write
    const asPointer = { id: "post", resolver: "http_fetch", config: { pointer: { type: "http_fetch", url: "http://localhost:18080/v2/impulses/resolve", method: "post", body: { pointer: { type: "concept_write" } } } } };
    expect((await judge(m, composition(asPointer))).refused).toBe(true);
    // an impulse-resolve task that sends an http_fetch pointer carries the same write
    const viaResolve = { id: "post", resolver: "impulse-resolve", config: { pointer: { type: "http_fetch", url: "http://127.0.0.1:8090/v2/impulses/resolve", method: "POST", body: JSON.stringify({ impulse: { type: "substrateGap_write" } }) } } };
    expect(m.fetchedResolveWrites(viaResolve)).toEqual(["substrateGap_write"]);
  });

  it("[MUST-FAIL] an opaque resolve POST is a write: unparseable body, a placeholder type, a placeholder body, a placeholder method or URL, no body", async () => {
    const m = await door();
    const url = "http://127.0.0.1:8080/v2/impulses/resolve";
    for (const cfg of [
      { url, method: "POST", body: "{\"impulse\": {\"type\": \"x\", \"limit\": {{n}}}}" },
      { url, method: "POST", body: JSON.stringify({ impulse: { type: "{{variables.shape}}" } }) },
      { url, method: "POST", body: "{{impulse:payload}}" },
      { url, method: "POST", body: JSON.stringify({ impulse: { pointer: { limit: 1 } } }) },
      { url, method: "{{variables.method}}", body: "{}" },
      { url: "{{variables.endpoint}}", method: "POST", body: "{}" },
      { url, method: "POST" },
    ]) {
      expect(m.fetchedResolveWrites(fetchTask(cfg))).toEqual([m.OPAQUE_RESOLVE_WRITE]);
      expect((await judge(m, composition(fetchTask(cfg)))).refused).toBe(true);
    }
  });

  it("CONTROL: an http_fetch GET, a POST to a non-resolve URL, and a resolve POST of a read shape are unaffected", async () => {
    const m = await door();
    const get = fetchTask({ url: "http://127.0.0.1:8090/v2/impulses/resolve?type=substrateGap_write" });
    const elsewhere = fetchTask({ url: "https://example.org/api/items", method: "POST", body: "{{impulse:payload}}" });
    const readResolve = fetchTask({ url: "http://127.0.0.1:8080/v2/impulses/resolve", method: "POST", body: JSON.stringify({ impulse: { type: "executionTraceWithSignatures", pointer: { type: "executionTraceWithSignatures", limit: 1 } } }) });
    for (const t of [get, elsewhere, readResolve]) {
      const r = await judge(m, composition(t));
      expect(r.refused).toBe(false);
      expect(r.lines).toEqual([]);
    }
  });

  it("CONTROL: a goal declared as a write still reaches its http_fetch write", async () => {
    const m = await door();
    expect((await judge(m, composition(GAP_POST), true)).refused).toBe(false);
    // and a store write that is the goal's own product still runs
    expect((await judge(m, composition(GAP_POST), false, new Set(["substrateGap_write"]))).refused).toBe(false);
  });

  it("a vessel resolver registered as <shape>/<kind> is judged by the shape it serves", async () => {
    const m = await door();
    const t = { id: "panel", output_shapes: ["llm_completion"], tasks: [{ id: "t1", resolver: "uiPanel_write/pattern", outputShapes: ["llm_completion"] }] };
    expect(m.templateRunShapes(t)).toContain("uiPanel_write");
    expect((await judge(m, t)).refused).toBe(true);
  });
});
