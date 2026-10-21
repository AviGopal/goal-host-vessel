/**
 * goal-host's own dispatches, IN PROCESS. A module that cannot import index.ts (it would be a cycle) reaches the
 * run-goal handler through this registration instead of POSTing to its own /run-goal: a self-call over HTTP would
 * need a key to pass the inbound door (inbound-auth.ts) and gains nothing, since it never leaves the process.
 * index.ts registers the handler bound to the node's own identity (SELF_PRINCIPAL), never an operator.
 */
export type InProcessRunGoal = (body: Record<string, unknown>) => Promise<Response>;

let registered: InProcessRunGoal | null = null;

export function setInProcessRunGoal(fn: InProcessRunGoal): void {
  registered = fn;
}

/** The registered handler, or null where index.ts has not registered one (an importer that is not the service). */
export function inProcessRunGoal(): InProcessRunGoal | null {
  return registered;
}
