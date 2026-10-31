// Extracted from index.ts so it can be TESTED: importing index.ts boots a server
// and throws on a missing LLM_VESSEL_ENDPOINT, so anything defined there is
// unreachable from a unit test. Same reason resolve-file-path.ts and
// goal-file-resolution.ts live outside it — and testing a re-declared COPY is
// the self-confirming-oracle failure this session already found twice.

// The predicate itself lives in resolve-pointer.ts, beside the required-input gate that reads it: the
// judge rules import resolve-pointer.ts, and their import closure is pinned (verdict-corpus/judge-rules-purity),
// so the gate cannot import this file. ONE definition, re-exported here for every existing importer.
export { isBookkeepingOnly } from "./resolve-pointer";
