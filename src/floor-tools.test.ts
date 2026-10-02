// Pins: the universal-tool floor offers a model NO shell. Floor run 27c1c600 (09-30)
// created /workspace/git/super-repo/GPT-5.md through the shellResult tool the floor
// offered as a read-only "inspect" tool. runGroundedToolLoop's allowlist is exactly the
// offered list, so a name absent here cannot be called by the floor's model.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FLOOR_FORBIDDEN_TOOLS, UNIVERSAL_READ_TOOLS } from "./floor-tools";

const names = UNIVERSAL_READ_TOOLS.map((t) => t.name);

describe("the floor's offered tools", () => {
  it("contain no shellResult, nor any other shell alias", () => {
    expect(names).not.toContain("shellResult");
    for (const f of FLOOR_FORBIDDEN_TOOLS) expect(names).not.toContain(f);
  });

  it("keep a read path that can count a file's lines exactly (the floor's positive control)", () => {
    expect(names).toEqual(expect.arrayContaining(["source_code", "fs_read", "codeSearchResult"]));
    const cs = UNIVERSAL_READ_TOOLS.find((t) => t.name === "codeSearchResult")!;
    expect(cs.description).toContain("line_count");
  });

  it("index.ts builds both grounded loops from this list and defines no second copy", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src).toContain('import { UNIVERSAL_READ_TOOLS } from "./floor-tools"');
    expect(src).not.toMatch(/const\s+UNIVERSAL_READ_TOOLS\s*=/);
    // Both model-driven loops take their tools from the shared list.
    expect(src).toContain("const tools: any[] = [...UNIVERSAL_READ_TOOLS];");
    expect(src).toContain("runGroundedToolLoop(invPrompt, UNIVERSAL_READ_TOOLS, [])");
    // The floor's and the investigation's prompts no longer steer the model to a shell tool.
    const floorPrompt = src.slice(src.indexOf("You are the substrate's universal executor."), src.indexOf("When finished, respond with the final answer/result"));
    expect(floorPrompt.length).toBeGreaterThan(100);
    expect(floorPrompt).not.toContain("shellResult");
    const invPrompt = src.slice(src.indexOf("const invLayout = "), src.indexOf("runGroundedToolLoop(invPrompt"));
    expect(invPrompt.length).toBeGreaterThan(100);
    expect(invPrompt).not.toContain("shellResult");
  });
});

describe("the floor's repo-wide code search (user ruling 10-02)", () => {
  it("offers fs_grep — a search with the webSearchResult result form — and still no shell", () => {
    expect(names).toContain("fs_grep");
    const g = UNIVERSAL_READ_TOOLS.find((t) => t.name === "fs_grep")!;
    expect(g.input_schema.required).toEqual(["pattern"]);
    expect(g.description).toContain("results[]");
    expect(g.description).toContain("repos/<vessel>");
    for (const f of FLOOR_FORBIDDEN_TOOLS) expect(names).not.toContain(f);
  });

  it("offers only read tools: no write, edit, commit or shell shape is in the list", () => {
    for (const n of names) expect(n).not.toMatch(/(_write|_create_write|^fs_write$|^fs_edit$|^git_commit|^code_(insert|replace|add_import)|shell|bash)/);
  });

  it("the floor prompt points the model at fs_grep for repo-wide search", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const floorPrompt = src.slice(src.indexOf("You are the substrate's universal executor."), src.indexOf("When finished, respond with the final answer/result"));
    expect(floorPrompt).toContain("fs_grep");
  });
});
