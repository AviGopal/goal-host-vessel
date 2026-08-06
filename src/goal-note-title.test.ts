import { describe, expect, it } from "bun:test";

import { orderWriteSinks, parseGoalNoteTitle } from "./goal-note-title";

/**
 * Two call sites bind a durable write from this parse — the composed-write title binding
 * and the terminal-output bridge. When they disagree the bridge writes a DUPLICATE note
 * beside the one the goal named and reports success, so a miss here is invisible at the
 * dispatch level and only shows up on an independent read-back of the named note.
 */
describe("parseGoalNoteTitle", () => {
  it("OBSERVED LIVE: an unquoted slug must parse, not fall through to a goal-text slug", () => {
    // dispatch 86f317f1 — the quoted-only parse returned null here, so the bridge wrote
    // "which-has-more-typescript-modules-repos-boredom-vessel-src-o" instead.
    expect(
      parseGoalNoteTitle(
        "Which has more TypeScript modules, repos/boredom-vessel/src or repos/discovery-vessel/src? Record the answer as a durable note titled vessel-ts-module-comparison-verify.",
      ),
    ).toBe("vessel-ts-module-comparison-verify");
  });

  it("still parses the quoted form the original binding handled", () => {
    expect(parseGoalNoteTitle('record it in a memory note titled "Substrate Reach Notes"')).toBe("Substrate Reach Notes");
    expect(parseGoalNoteTitle("save a note titled 'ribosome-src-ts-count'")).toBe("ribosome-src-ts-count");
  });

  it("parses the explicit key form", () => {
    expect(parseGoalNoteTitle("write the finding, title: weekly-reach-summary")).toBe("weekly-reach-summary");
    expect(parseGoalNoteTitle("write the finding, title=weekly-reach-summary")).toBe("weekly-reach-summary");
  });

  it("does NOT swallow a trailing prose clause into a bare title", () => {
    // The bare arm is single-token by construction; without that bound the title would
    // become a sentence fragment and the note id an unusable 80-char slug.
    expect(parseGoalNoteTitle("record it in a note titled reach-summary and then tell me the count")).toBe("reach-summary");
  });

  it("returns null when the goal names no title", () => {
    expect(parseGoalNoteTitle("count the TypeScript files under repos/x/src")).toBeNull();
    expect(parseGoalNoteTitle("record the answer as a durable note")).toBeNull();
  });

  it("does not fire on an unrelated use of the word 'title'", () => {
    expect(parseGoalNoteTitle("list every note whose title is missing")).toBeNull();
    // The bare arm is past-tense only for this reason: "title was missing" would
    // otherwise bind "was" as the note title, and the length bound alone doesn't save it.
    expect(parseGoalNoteTitle("report every note whose title was missing")).toBeNull();
    expect(parseGoalNoteTitle("check whether the title matches the body")).toBeNull();
  });

  it("keeps a slug's punctuation, since the id is derived from it", () => {
    expect(parseGoalNoteTitle("note titled reference-audit-2026-08-06")).toBe("reference-audit-2026-08-06");
    expect(parseGoalNoteTitle("note titled docs/SUBSTRATE.md")).toBe("docs/SUBSTRATE.md");
  });
});

describe('orderWriteSinks', () => {
  it('OBSERVED LIVE: a titled goal must not lose to a vault sink that sorted first', () => {
    // dispatch 00a97dc6 — target carried both after a re-frame, obsidian won on Set order,
    // and the note the goal named kept its placeholder while the bridge logged success.
    expect(orderWriteSinks(['obsidian:write_note', 'memoryNote_write'], true)[0]).toBe('memoryNote_write');
  });

  it('leaves the declared order alone when the goal names no title', () => {
    expect(orderWriteSinks(['obsidian:write_note', 'memoryNote_write'], false)).toEqual(['obsidian:write_note', 'memoryNote_write']);
  });

  it('always appends obsidian:write_note as the tail fallback, without duplicating it', () => {
    expect(orderWriteSinks(['memoryNote_write'], true)).toEqual(['memoryNote_write', 'obsidian:write_note']);
    expect(orderWriteSinks(['obsidian:write_note'], true)).toEqual(['obsidian:write_note']);
    expect(orderWriteSinks([], false)).toEqual(['obsidian:write_note']);
  });

  it('ignores target shapes that are not durable writes', () => {
    expect(orderWriteSinks(['shellResult', 'goal', 'memoryNote_write'], true)).toEqual(['memoryNote_write', 'obsidian:write_note']);
  });
});
