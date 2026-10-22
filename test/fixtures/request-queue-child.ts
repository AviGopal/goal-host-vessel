// A separate goal-host-side process for test/request-queue-resolve.test.ts: it opens the request store at argv[2] as a
// restarted process would (no memory of the parent's), does one thing, prints the result as JSON, and exits.
//   enqueue <dir> <dispatchId> <dispatcherLabel> <origin>  — enqueue one human_input request and exit
//   lease   <dir> <label>                                   — lease as <label> offering person_present
const [mode, dir, a, b, c] = process.argv.slice(2);
const q = await import("../../src/request-queue");
q.setRequestQueueRoot(dir!);
if (mode === "enqueue") {
  const r = await q.enqueueRequest({ dispatch_id: a!, origin: (c as "system" | "operator") ?? "system", dispatcher: b!, goal: "request-queue falsifier goal", shape: "human_input", description: "a question asked before the restart", required: { capabilities: ["person_present"] }, deadline: Date.now() + 30 * 60_000 });
  console.log(JSON.stringify(r));
} else if (mode === "lease") {
  console.log(JSON.stringify(await q.leaseRequest({ label: a!, scopes: ["read", "write"] }, { capabilities: ["person_present"] })));
} else {
  console.log(JSON.stringify({ error: `unknown mode ${mode}` }));
  process.exit(2);
}
