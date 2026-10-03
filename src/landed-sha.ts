/**
 * landedShaForGoal — ask discovery which commit landed for a goal (`goal_path_sha`).
 *
 * Extracted from src/index.ts so it can be exercised without booting the host.
 *
 * THE REQUEST CARRIES GOAL-HOST'S KEY. The original posted with a Content-Type
 * header only, so discovery's auth middleware answered 401 on every call — about
 * 270 failures in one day, fleet-wide — and every landed-SHA lookup degraded to
 * null without anything looking wrong. Discovery here is goal-host's OWN configured
 * endpoint (Config.discoveryEndpoint), never caller-supplied, so attaching the key
 * is what every other goal-host → discovery call already does. The key travels in
 * the Authorization header only: never in the URL, never in a log line.
 */
import { Config } from "./config";

export interface LandedShaDeps {
  endpoint?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export async function landedShaForGoal(goal: string, deps: LandedShaDeps = {}): Promise<string | null> {
  const endpoint = deps.endpoint ?? Config.discoveryEndpoint;
  const apiKey = deps.apiKey ?? Config.metabob.apiKey;
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${endpoint}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
      body: JSON.stringify({
        pointer: { type: "goal_path_sha", goal },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn(`Failed to resolve SHA for goal '${goal.slice(0, 50)}...': ${response.status} ${response.statusText}`);
      return null;
    }
    const json = (await response.json()) as { content?: { sha?: string } } | null;
    return json?.content?.sha ?? null;
  } catch (e) {
    console.error(`Error resolving SHA for goal '${goal.slice(0, 50)}...': ${e}`);
    return null;
  }
}
