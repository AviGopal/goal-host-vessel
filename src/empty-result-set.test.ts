// Pins the empty-store-listing guard.
//
// THE DEFECT: a bare vessel-resolve for a shape that activity-api also STORES is
// answered by the store's LIST endpoint. An empty listing arrives as
// success:true with a non-empty `content` string, so every existing guard passes
// it and the walk records the shape as PRODUCED — after which the consuming step
// fails with "no constructible payload" and the real drafter is never reached.
//
// Imports the REAL module; a re-implemented copy would pass while the shipped
// guard rots.
import { describe, expect, test } from "bun:test";
import { emptyResultSetReason } from "./empty-result-set";

// The exact body fetched from the live fleet on the edit path.
const LIVE_EMPTY_LISTING = {
  success: true,
  content: '{"total":0,"offset":0,"limit":100,"entries":[]}',
  metadata: {
    shape: "code_modification_proposal",
    summary: "0 code_modification_proposal rows",
    rowCount: 0,
  },
};

describe("emptyResultSetReason — catches the query miss", () => {
  test("the live body that broke the edit path is refused", () => {
    const r = emptyResultSetReason(LIVE_EMPTY_LISTING.content, LIVE_EMPTY_LISTING.metadata);
    expect(r).not.toBeNull();
    expect(r).toContain("code_modification_proposal");
  });

  test("rowCount 0 alone is enough, without parsing the payload", () => {
    expect(emptyResultSetReason("anything at all", { shape: "x", rowCount: 0 })).not.toBeNull();
  });

  test("an empty entries array beside pagination keys is refused", () => {
    expect(emptyResultSetReason('{"total":0,"offset":0,"limit":100,"entries":[]}')).not.toBeNull();
    expect(emptyResultSetReason({ total: 0, limit: 50, entries: [] })).not.toBeNull();
  });

  test("an empty PAGE of a non-empty listing is named accurately", () => {
    const r = emptyResultSetReason({ total: 42, offset: 900, limit: 100, entries: [] });
    expect(r).toContain("EMPTY PAGE");
    expect(r).toContain("42");
  });
});

describe("emptyResultSetReason — must NOT over-reject", () => {
  test('"zero results" is a legitimate ANSWER for a counting goal', () => {
    // The over-correction guard. A counting/search goal that honestly finds
    // nothing produces a real artifact; refusing it would break more than the
    // bug ever did.
    expect(emptyResultSetReason('{"count":0,"files":[]}')).toBeNull();
    expect(emptyResultSetReason({ count: 0, matches: [] })).toBeNull();
  });

  test("a NON-empty listing passes", () => {
    expect(
      emptyResultSetReason('{"total":3,"offset":0,"limit":100,"entries":[{"id":"a"}]}'),
    ).toBeNull();
    expect(emptyResultSetReason("x", { shape: "y", rowCount: 3 })).toBeNull();
  });

  test("an empty entries array with NO pagination keys is left alone", () => {
    // Without pagination markers this is not identifiable as a store listing,
    // and guessing would catch legitimate producers whose payload happens to
    // carry an `entries` field.
    expect(emptyResultSetReason({ entries: [] })).toBeNull();
  });

  test("ordinary content and non-JSON strings are untouched", () => {
    expect(emptyResultSetReason("the answer is 42")).toBeNull();
    expect(emptyResultSetReason('{"stdout":"hello"}')).toBeNull();
    expect(emptyResultSetReason(null)).toBeNull();
    expect(emptyResultSetReason(undefined)).toBeNull();
    expect(emptyResultSetReason(12345)).toBeNull();
  });

  test("malformed JSON is passed through rather than thrown on", () => {
    expect(emptyResultSetReason("{not json")).toBeNull();
    expect(emptyResultSetReason("{'total':0,'entries':[]}")).toBeNull();
  });
});
