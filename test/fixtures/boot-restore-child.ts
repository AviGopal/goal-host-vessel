// CHILD for test/boot-restore-dispatch-store.test.ts. Run as `bun <this file> <mode>` in a fresh process, never by
// `bun test` (the loader plugin applies only to a module not yet loaded; the technique of goal-path-record-child.ts).
//
// GOAL_HOST_DISPATCH_STORE_PATH points at a seeded store in a scratch dir (set by the parent test). Every fetch is
// refused and recorded. mode "boot" calls restoreDispatchStoreAtBoot (what the service's boot does); mode "import"
// only imports index.ts (what every importer does). One line out:
//   BOOT_RESTORE_RESULT {"exposed":bool,"mode":…,"records":{id:{status,reached}},"storeAfter":string,"refused":[url...]}
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INDEX_PATH = join(import.meta.dir, "..", "..", "src", "index.ts");
const escaped = INDEX_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
Bun.plugin({
  name: "boot-restore-export",
  setup(build) {
    build.onLoad({ filter: new RegExp(`^${escaped}$`) }, (args) => {
      const text = readFileSync(args.path, "utf8");
      const boot = /\basync function restoreDispatchStoreAtBoot\(/.test(text) ? ", restoreDispatchStoreAtBoot as __t_restore" : "";
      return { contents: `${text}\nexport { executionStore as __t_store${boot} };\n`, loader: "ts" };
    });
  },
});

const realFetch = globalThis.fetch;
const refused: string[] = [];
globalThis.fetch = ((input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  refused.push(url);
  return Promise.reject(new TypeError("fetch refused (test: no network)"));
}) as typeof fetch;

const mode = process.argv[2] ?? "import";
const storePath = process.env["GOAL_HOST_DISPATCH_STORE_PATH"] ?? "";
const result: { exposed: boolean; mode: string; records: Record<string, { status: unknown; reached: unknown }>; storeAfter: string; refused: string[]; error?: string } = { exposed: false, mode, records: {}, storeAfter: "", refused };
try {
  const mod = (await import(INDEX_PATH)) as Record<string, unknown>;
  const store = mod["__t_store"] as Map<string, { status?: unknown; reached?: unknown }> | undefined;
  const restore = mod["__t_restore"] as (() => Promise<void>) | undefined;
  result.exposed = !!store && typeof restore === "function";
  if (mode === "boot") {
    if (!restore) throw new Error("index.ts exposes no restoreDispatchStoreAtBoot");
    await restore();
  }
  for (const [id, r] of store ?? []) result.records[id] = { status: r.status, reached: r.reached };
  result.storeAfter = readFileSync(storePath, "utf8");
} catch (e) {
  result.error = String((e as Error)?.stack ?? e).slice(0, 2000);
}
globalThis.fetch = realFetch;
console.log(`BOOT_RESTORE_RESULT ${JSON.stringify(result)}`);
process.exit(0);
