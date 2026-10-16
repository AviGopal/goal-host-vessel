// The tools the universal-tool floor (universalToolFallback) and the grounded
// investigation loop offer a model. Both run through runGroundedToolLoop, whose
// allowlist is exactly this list plus the goal's own target write shapes, so a name
// that is not here cannot be called from either loop.
//
// NO SHELL (shellResult). It was offered here as a read-only "inspect" tool, but it is
// the general shell: local-tools runs it as `bash -c` with cwd = WORKSPACE_ROOT, the
// LIVE super-repo clone, and the 10-02 write containment (fs_write / fs_edit / code_* /
// git_commit refusals, FS_WRITE_SHAPES) never covered it. Floor run 27c1c600 (09-30)
// created /workspace/git/super-repo/GPT-5.md through it. A model-authored command is
// not a read because the tool's description says so. The read tools below remain:
// line counts come from codeSearchResult (its result carries `line_count`, = wc -l), file
// contents from fs_read (source_code, which discovery no longer serves, was dropped under the 10-16 ruling), and a
// repo-wide search from fs_grep. local-tools also gates its shell
// (shell-containment.ts) as a second layer, for every other caller.
export const UNIVERSAL_READ_TOOLS = [
  { name: "fs_read", description: "Read a file's contents by path.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "codeSearchResult", description: "Grep a single file for a regex pattern. The result also carries line_count (the file's exact line count, identical to `wc -l`) and match_count; to count a file's lines, call this with any pattern and read line_count.", input_schema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"] } },
  // REPO-WIDE CODE SEARCH (user ruling 10-02: "restore the floor's code search; this should be a
  // shape that web search outputs"). development-vessel fs_grep: an in-process, read-only walk of
  // every vessel's source (no shell, no write path), whose result carries the webSearchResult form
  // `results: [{title, url, snippet}]` with url the vessel-qualified `repos/<vessel>/...` path the
  // citation oracle re-reads. It replaces the repo-wide grep/find the floor lost with shellResult.
  { name: "fs_grep", description: "Search the source of EVERY vessel for a regex (case-insensitive), like grep -rn, without a shell. Omit path to search all vessels, or pass repos/<vessel> to narrow. The result's results[] is [{title, url, snippet}] like a web search: url is the vessel-qualified file path (repos/<vessel>/...) and title adds :line. Cite url (and the line) VERBATIM; then read the file with fs_read if you need more than the snippet.", input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, fileGlob: { type: "string" } }, required: ["pattern"] } },
  { name: "substrateGap", description: "Query the substrate's gaps. Optional filters: category, status (open/closed), limit. Use this to read or aggregate substrate gaps.", input_schema: { type: "object", properties: { category: { type: "string" }, status: { type: "string" }, limit: { type: "number" } }, required: [] } },
];

/** Shapes the floor must never offer a model: they execute arbitrary commands. */
export const FLOOR_FORBIDDEN_TOOLS: readonly string[] = ["shellResult", "shell", "bash", "bounded_shell", "boundedShellResult"];

// ── THE FLOOR OFFERS WHAT DISCOVERY SERVES (CHANGE-29; user ruling 2026-10-16T06:06:38Z, "Own-substrate, any
// non-forbidden"). The offer was hand-written from day one (1cf0b96): a goal whose target is an advertised, readable
// shape (docs_align_tick, system_load_report) reached a floor that could not call it. Now: the hand list minus any
// entry discovery no longer advertises (source_code), PLUS a tool per target shape that is advertised, not a shell
// (FLOOR_FORBIDDEN_TOOLS), not a non-shape token (NAMED_SHAPE_EXCLUDE), and served on THIS substrate (index.ts
// checks the producer; a foreign row is refused, also when the tool is called).

/** The hand list's names, without entries the known vocabulary no longer advertises. An unknown (empty) vocabulary
 *  keeps the whole list: unreachable discovery must not strip the floor. */
export function floorHandToolNames(known: ReadonlySet<string>): string[] {
  const all = UNIVERSAL_READ_TOOLS.map((t) => t.name);
  return known.size === 0 ? all : all.filter((n) => known.has(n));
}

/** The goal's target shapes the floor may offer as their own tool, before the own-substrate producer check. Write
 *  shapes are left out: they keep their own write-tool path. */
export function floorTargetCandidates(targetShapes: readonly string[], known: ReadonlySet<string>, excluded: ReadonlySet<string>): string[] {
  const hand = new Set(UNIVERSAL_READ_TOOLS.map((t) => t.name));
  return [...new Set(targetShapes)].filter((s) =>
    typeof s === "string" && s.length > 0 && known.has(s) && !hand.has(s) && !/(_write|_create_write)$/.test(s)
    && !FLOOR_FORBIDDEN_TOOLS.includes(s) && !excluded.has(s));
}
