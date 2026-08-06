import { describe, expect, it } from "bun:test";

import { parseFileExtension } from "./file-extension";

/**
 * This parse is shared by the command builder and its reach oracle, so a mistake here is
 * invisible to grading — the two agree by construction and produce a confidently wrong
 * verdict in EITHER direction. Both directions have now happened live, which is why these
 * cases are pinned rather than left to a code comment.
 */
describe("parseFileExtension", () => {
  it("FALSE RED, observed live: a language name qualifying 'module' must narrow the filter", () => {
    // "Tally every TypeScript MODULE beneath repos/boredom-vessel/src" parsed ext=null,
    // counted all 7 files (6 .ts + 1 .json) and beta-penalised the CORRECT answer of 6.
    expect(parseFileExtension("Tally every TypeScript module beneath repos/boredom-vessel/src")).toBe("ts");
  });

  it("FALSE GREEN, observed live: 'TypeScript files' must not fall through to all-files", () => {
    // Answered 18 for a tree holding 17 .ts plus one .js, and the oracle alpha-credited it.
    expect(parseFileExtension("how many TypeScript files are under repos/x/src")).toBe("ts");
  });

  it("still accepts the dotted literal", () => {
    expect(parseFileExtension("count the .ts files in repos/x/src")).toBe("ts");
    expect(parseFileExtension("count the .md modules in repos/x/docs")).toBe("md");
  });

  it("accepts the other countable nouns a goal may reasonably use", () => {
    expect(parseFileExtension("count every Python script under repos/x")).toBe("py");
    expect(parseFileExtension("how many Rust sources are in repos/x/src")).toBe("rs");
  });

  it("allows one intervening word between the language and the noun", () => {
    expect(parseFileExtension("count the TypeScript source files in repos/x/src")).toBe("ts");
  });

  it("does NOT narrow when the language name is merely mentioned, not qualifying", () => {
    // The guard the old co-occurrence test was written for. It must survive the change:
    // these ask about file CONTENT, not file type.
    expect(parseFileExtension("count the files that mention TypeScript")).toBeNull();
    expect(parseFileExtension("how many files reference Python in repos/x")).toBeNull();
  });

  it("returns null when no filter is asked for, so the count stays all-files", () => {
    expect(parseFileExtension("how many files are under repos/x/src")).toBeNull();
    expect(parseFileExtension("summarise repos/x/src")).toBeNull();
  });

  it("matches Go, whose table entry no longer carries its own noun", () => {
    // The entry used to bake in "files"; adjacency now supplies that, and leaving both
    // would have required the noun twice so Go could never match.
    expect(parseFileExtension("count the Go files in repos/x")).toBe("go");
    expect(parseFileExtension("count the golang modules in repos/x")).toBe("go");
  });

  it("matches an alternation entry (shell|bash) through the adjacency rewrite", () => {
    // `/\bshell|\bbash\b/` has an ungrouped alternation; the adjacency regex wraps the
    // pattern body, so both arms must still work.
    expect(parseFileExtension("count the shell scripts in scripts/")).toBe("sh");
    expect(parseFileExtension("count the bash scripts in scripts/")).toBe("sh");
  });

  it("prefers an explicit dotted extension over a language name elsewhere in the goal", () => {
    expect(parseFileExtension("count the .json files that configure TypeScript")).toBe("json");
  });
});
