/**
 * Typed configuration singleton for goal-host-vessel.
 * Loaded from environment variables; drift surfaces as a type error.
 */

function parseEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseEnvBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

interface MetabobConfig {
  apiKey: string;
}

interface Config {
  port: number;
  host: string;
  metabob: MetabobConfig;
  llmVesselEndpoint: string | undefined;
  anthropicApiKey: string | undefined;
  goalHostEndpoint: string;
  discoveryEndpoint: string;
  activityApiEndpoint: string;
  fedTransportEgress: string;
  busMaxInflight: number;
  busMaxInflightBytes: number;
  busQueueMax: number;
  busBackpressureMaxWaitMs: number;
  busStatsIntervalMs: number;
  dispatchDropLogPath: string;
  llmRouterDisabled: boolean;
  memRingSize: number;
  memDumpIntervalMs: number;
  resolveTimeoutMs: number;
}

export const Config: Config = {
  port: parseEnvInt("GOAL_HOST_VESSEL_PORT", 8210),
  host: process.env["GOAL_HOST_VESSEL_HOST"] ?? "0.0.0.0",
  metabob: {
    apiKey:
      process.env["GOAL_HOST_VESSEL_API_KEY"] ??
      process.env["METABOB_API_KEY"] ??
      "",
  },
  llmVesselEndpoint: process.env["LLM_VESSEL_ENDPOINT"],
  anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
  goalHostEndpoint:
    process.env["GOAL_HOST_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8210",
  discoveryEndpoint:
    process.env["DISCOVERY_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8100",
  activityApiEndpoint:
    process.env["PRODUCER_DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8080",
  fedTransportEgress:
    process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401",
  busMaxInflight: parseEnvInt("IAS_BUS_MAX_INFLIGHT", parseEnvInt("BUS_MAX_INFLIGHT", 256)),
  busMaxInflightBytes: parseEnvInt("BUS_MAX_INFLIGHT_BYTES", 50 * 1024 * 1024),
  busQueueMax: parseEnvInt("IAS_BUS_QUEUE_SIZE", parseEnvInt("BUS_QUEUE_MAX", 1024)),
  busBackpressureMaxWaitMs: parseEnvInt("IAS_BUS_BACKPRESSURE_MAX_WAIT_MS", 30_000),
  busStatsIntervalMs: 30_000,
  dispatchDropLogPath:
    process.env["IAS_BUS_DROP_LOG_PATH"] ?? "/workspace/dispatch-dropped.jsonl",
  llmRouterDisabled: parseEnvBool("LLM_ROUTER_DISABLED", false),
  memRingSize: parseEnvInt("MEM_RING_SIZE", 512),
  memDumpIntervalMs: parseEnvInt("MEM_DUMP_INTERVAL_MS", 5_000),
  resolveTimeoutMs: parseEnvInt("RESOLVE_TIMEOUT_MS", 60_000),
};
