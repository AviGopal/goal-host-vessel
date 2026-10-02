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
// contents from source_code / fs_read, and a repo-wide search from fs_grep. local-tools also gates its shell
// (shell-containment.ts) as a second layer, for every other caller.
export const UNIVERSAL_READ_TOOLS = [
  { name: "source_code", description: "Read a repo file's full source by repo-relative filePath. Read it yourself; never ask for it.", input_schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
  { name: "fs_read", description: "Read a file's contents by path.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "codeSearchResult", description: "Grep a single file for a regex pattern. The result also carries line_count (the file's exact line count, identical to `wc -l`) and match_count; to count a file's lines, call this with any pattern and read line_count.", input_schema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"] } },
  // REPO-WIDE CODE SEARCH (user ruling 10-02: "restore the floor's code search; this should be a
  // shape that web search outputs"). development-vessel fs_grep: an in-process, read-only walk of
  // every vessel's source (no shell, no write path), whose result carries the webSearchResult form
  // `results: [{title, url, snippet}]` with url the vessel-qualified `repos/<vessel>/...` path the
  // citation oracle re-reads. It replaces the repo-wide grep/find the floor lost with shellResult.
  { name: "fs_grep", description: "Search the source of EVERY vessel for a regex (case-insensitive), like grep -rn, without a shell. Omit path to search all vessels, or pass repos/<vessel> to narrow. The result's results[] is [{title, url, snippet}] like a web search: url is the vessel-qualified file path (repos/<vessel>/...) and title adds :line. Cite url (and the line) VERBATIM; then read the file with source_code or fs_read if you need more than the snippet.", input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, fileGlob: { type: "string" } }, required: ["pattern"] } },
  { name: "substrateGap", description: "Query the substrate's gaps. Optional filters: category, status (open/closed), limit. Use this to read or aggregate substrate gaps.", input_schema: { type: "object", properties: { category: { type: "string" }, status: { type: "string" }, limit: { type: "number" } }, required: [] } },
];

/** Shapes the floor must never offer a model: they execute arbitrary commands. */
export const FLOOR_FORBIDDEN_TOOLS: readonly string[] = ["shellResult", "shell", "bash", "bounded_shell", "boundedShellResult"];
