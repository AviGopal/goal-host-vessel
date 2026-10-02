import { describe, expect, test } from "bun:test";
import { isTransientFailure } from "../src/transient-failure";

describe("isTransientFailure: a known status decides; text only when no response arrived", () => {
  test("5xx and 429 are transient by status", () => {
    expect(isTransientFailure("anything", 503)).toBe(true);
    expect(isTransientFailure("", 429)).toBe(true);
  });
  test("a 4xx is not transient even when its body mentions a transient word", () => {
    expect(isTransientFailure("timeout", 400)).toBe(false);
    expect(isTransientFailure("upstream unavailable", 404)).toBe(false);
  });
  test("with no status, transport text is transient", () => {
    expect(isTransientFailure("transport: fetch failed")).toBe(true);
    expect(isTransientFailure("ECONNREFUSED 127.0.0.1:8230")).toBe(true);
  });
  test("429/402 match only as whole numbers, not inside a digit run", () => {
    expect(isTransientFailure("read 14290 bytes")).toBe(false);
    expect(isTransientFailure("id 34021 rejected")).toBe(false);
    expect(isTransientFailure("provider said 429")).toBe(true);
  });
  test("a request error with no status is not transient", () => {
    expect(isTransientFailure("invalid argument: path")).toBe(false);
  });
});
