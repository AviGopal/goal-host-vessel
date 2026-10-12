// The routing corpus runner: a thin re-export of the closed core's runner (src/routing-core/corpus-runner.ts), so the
// protected tests, cli.ts and any live runner share ONE copy of the replay and compare logic and cannot drift.
export * from "../../src/routing-core/corpus-runner";
export { verifyChain, canonical, sha256, linkOf, manifestLine, GENESIS } from "../../src/routing-core/corpus-chain";
