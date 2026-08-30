import { describe, expect, test } from "bun:test";
import { quoteUrlsWithAmpersands, COMMAND_KEYS } from "../src/command-repair";

// An unquoted `&` inside a URL is a bash background operator. local-tools-vessel wraps every
// command as `( <command> ) &`, so the parameter after the `&` becomes a variable assignment and
// the command returns EMPTY STDOUT WITH EXIT 0 — a failure that looks exactly like an endpoint
// returning nothing. The walk's self-correction loop cannot see it and re-emits the same command.
describe("quoteUrlsWithAmpersands", () => {
  test("quotes the URL from the measured concept-db failure", () => {
    // Verbatim from dispatch 44acaa4a, which produced empty stdout 7 times.
    const broken = "curl -s http://127.0.0.1:8260/concepts/search?q=&limit=1 | head -c 4000";
    expect(quoteUrlsWithAmpersands(broken)).toBe(
      "curl -s 'http://127.0.0.1:8260/concepts/search?q=&limit=1' | head -c 4000",
    );
  });

  test("quotes only the URL and preserves a following && chain", () => {
    // The dangerous edge: a real `&&` operator must survive, and only the URL token is quoted.
    expect(quoteUrlsWithAmpersands("curl -s http://a/?x=1&y=2 && echo done")).toBe(
      "curl -s 'http://a/?x=1&y=2' && echo done",
    );
  });

  test("is idempotent — re-running never double-quotes", () => {
    const once = quoteUrlsWithAmpersands("curl -s http://a/?x=1&y=2");
    expect(quoteUrlsWithAmpersands(once)).toBe(once);
  });

  test.each([
    ["curl -s 'http://x/?a=1&b=2'", "already single-quoted"],
    ['curl -s "http://x/?a=1&b=2"', "already double-quoted"],
    ["sleep 5 &", "legitimate backgrounding, no URL"],
    ["make a && make b", "legitimate && chaining, no URL"],
    ["curl http://x/path", "URL with no query string"],
    ["curl http://x/?a=1", "query string with no &"],
    ["echo 'a & b'", "ampersand inside quotes, not a URL"],
  ])("leaves %p unchanged (%s)", (input) => {
    // NEGATIVE CONTROLS. A repair that fires on these would corrupt correct commands — the failure
    // mode is worse than the bug, because it would rewrite every command the walk ever runs.
    expect(quoteUrlsWithAmpersands(input)).toBe(input);
  });

  test("repairs every URL when a command carries more than one", () => {
    expect(quoteUrlsWithAmpersands("curl http://a/?x=1&y=2 http://b/?p=3&q=4")).toBe(
      "curl 'http://a/?x=1&y=2' 'http://b/?p=3&q=4'",
    );
  });

  test("COMMAND_KEYS covers only shell-executed args", () => {
    // Bare `url`/`endpoint` args are fetched directly, not run through a shell; quoting those
    // would embed a literal ' into the request.
    expect([...COMMAND_KEYS]).toEqual(["command", "cmd", "script", "sql"]);
    expect(COMMAND_KEYS).not.toContain("url" as never);
    expect(COMMAND_KEYS).not.toContain("endpoint" as never);
  });
});
