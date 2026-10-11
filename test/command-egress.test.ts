// Pins the origin rule for LLM-synthesised executor commands (src/command-egress.ts) and its wiring
// into the walk (src/index.ts). The end-to-end replays through the real walk are in
// test/command-egress-loop.test.ts; this file is pure and runs anywhere, including the container.
//
// The rule: a correction may never change the scheme, host or port of the ORIGINAL command (the first
// command of that executor call), and an initial synthesis may name only loopback or an origin the
// goal names. Observed on node1 (dispatch 28a669b3): local audit commands were rewritten to invented
// external hosts and run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandOf, originKey, originsOfCommand, sameOriginOrRefuse, synthesisWithinInputsOrRefuse } from "../src/command-egress";

// The helper decides; it must never perform I/O. Any fetch or spawn while these tests run fails them.
const realFetch = globalThis.fetch;
const realSpawn = Bun.spawn;
let io = 0;
beforeAll(() => {
  globalThis.fetch = (async () => { io++; throw new Error("command-egress test: no network"); }) as unknown as typeof fetch;
  (Bun as { spawn: unknown }).spawn = () => { io++; throw new Error("command-egress test: no spawn"); };
});
afterAll(() => {
  globalThis.fetch = realFetch;
  (Bun as { spawn: unknown }).spawn = realSpawn;
  expect(io).toBe(0);
});

const keys = (cmd: string) => originsOfCommand(cmd).map(originKey);

const STEP9_ORIG = "curl -s 'http://127.0.0.1:8100/landing-paths/audit?since=24h' | jq '.paths | length'";
const STEP52_ORIG = "curl -s http://127.0.0.1:8100/landing/audit | jq '.lanes | length'";

describe("(a) the observed rewrites are refused", () => {
  test("step 9: 127.0.0.1:8100 → api.merlonix.com → internetvitals.com", () => {
    for (const hop of [
      "curl -s 'https://api.merlonix.com/v1/public/landing-paths/audit?since=24h' | jq '.paths | length'",
      "curl -s https://internetvitals.com/api/v1/health | jq .",
    ]) {
      const v = sameOriginOrRefuse(STEP9_ORIG, hop);
      expect(v.ok).toBe(false);
      expect(v.allowed).toEqual(["http://127.0.0.1:8100"]);
    }
    expect(sameOriginOrRefuse(STEP9_ORIG, "curl -s https://api.merlonix.com/v1/x").introduced).toEqual(["https://api.merlonix.com:443"]);
  });

  test("step 52: every hop of the chain is refused against the ORIGINAL, not just the previous attempt", () => {
    const chain = [
      "curl -s https://dannykeane.com/developers/api | head -c 4000",
      "curl -s 'https://api.github.com/repos/your/repository/commits?since=2026-10-10T00:00:00Z' | jq length",
      "curl -s 'https://api.merlonix.com/v1/public/improvement-lane-status?since=2026-10-10T00:00:00Z' | jq .",
      "curl -s https://merlonix.com/docs/public-api/ | head -c 4000",
    ];
    for (let i = 0; i < chain.length; i++) {
      expect(sameOriginOrRefuse(STEP52_ORIG, chain[i]).ok).toBe(false);
      // Against the previous hop the next one would also differ — but the rule is anchored on the original.
      if (i > 0) expect(sameOriginOrRefuse(STEP52_ORIG, chain[i]).allowed).toEqual(["http://127.0.0.1:8100"]);
    }
  });
});

describe("(b) a local→local fix is allowed", () => {
  test.each([
    ["new path, flags and quoting", "curl -sS \"http://127.0.0.1:8100/landing-paths/audit?since=24h&format=json\" | jq -r '.paths | length'"],
    ["no scheme (curl's default is http)", "curl -s 127.0.0.1:8100/landing-paths/audit | jq ."],
    ["a raw-body inspection", "curl -s 'http://127.0.0.1:8100/landing-paths/audit' | head -c 4000"],
    ["no network at all", "echo UNKNOWN"],
  ])("%s", (_n, cand) => {
    expect(sameOriginOrRefuse(STEP9_ORIG, cand).ok).toBe(true);
  });

  test("a different loopback PORT is a new origin", () => {
    expect(sameOriginOrRefuse(STEP9_ORIG, "curl -s http://127.0.0.1:8080/landing-paths").introduced).toEqual(["http://127.0.0.1:8080"]);
    expect(sameOriginOrRefuse(STEP9_ORIG, "curl -s https://127.0.0.1:8100/landing-paths").introduced).toEqual(["https://127.0.0.1:8100"]);
  });
});

describe("(c) an external original keeps its own host", () => {
  const JPL = "curl -s 'https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND=501' | head -c 4000";
  test("corrected on the same host: allowed", () => {
    expect(sameOriginOrRefuse(JPL, "curl -s 'https://ssd.jpl.nasa.gov/api/horizons.api?format=json&QUANTITIES=%2720%27' | jq -r .result").ok).toBe(true);
    expect(sameOriginOrRefuse(JPL, "curl -s 'https://SSD.JPL.NASA.GOV:443/api/horizons.api'").ok).toBe(true);
  });
  test("switched to another external host, or another port/scheme of the same host: refused", () => {
    expect(sameOriginOrRefuse(JPL, "curl -s https://api.le-systeme-solaire.net/rest/bodies/io").introduced).toEqual(["https://api.le-systeme-solaire.net:443"]);
    expect(sameOriginOrRefuse(JPL, "curl -s http://ssd.jpl.nasa.gov/api/horizons.api").ok).toBe(false);
    expect(sameOriginOrRefuse(JPL, "curl -s https://ssd.jpl.nasa.gov:8443/api").ok).toBe(false);
  });
  test("a goal that NAMES a host admits it for a correction too", () => {
    expect(sameOriginOrRefuse(STEP9_ORIG, "curl -s https://ssd.jpl.nasa.gov/api/horizons.api", ["Ask ssd.jpl.nasa.gov for Io's distance"]).ok).toBe(true);
  });
});

describe("(d) an original with no URL admits none", () => {
  test("adding a URL is refused; staying local is allowed", () => {
    const orig = "find repos/goal-host-vessel/src -name '*.ts' | wc -l";
    expect(sameOriginOrRefuse(orig, "curl -s https://api.github.com/repos/x/y/contents/src | jq length").introduced).toEqual(["https://api.github.com:443"]);
    expect(sameOriginOrRefuse(orig, "curl -s http://127.0.0.1:8100/health").ok).toBe(false);
    expect(sameOriginOrRefuse(orig, "find repos/goal-host-vessel/src -type f -name '*.ts' | wc -l").ok).toBe(true);
    expect(sameOriginOrRefuse(undefined, "curl -s https://example.org/").ok).toBe(false);
    expect(sameOriginOrRefuse(undefined, undefined).ok).toBe(true);
  });
});

describe("(e) loopback equivalence", () => {
  test.each([
    ["http://127.0.0.1:8100/x", "http://localhost:8100/y"],
    ["http://localhost:8100/x", "http://[::1]:8100/y"],
    ["http://[::1]:8100/x", "http://127.0.0.1:8100/y"],
  ])("%s ≡ %s", (a, b) => {
    expect(sameOriginOrRefuse(`curl -s ${a}`, `curl -s -g '${b}'`).ok).toBe(true);
  });
  test("a host literally named `loopback` is not the loopback class", () => {
    expect(sameOriginOrRefuse("curl -s http://127.0.0.1:8100/x", "curl -s http://loopback:8100/x").introduced).toEqual(["http://loopback:8100"]);
  });
  test("0.0.0.0 and 127.0.0.2 are not in the loopback class", () => {
    expect(sameOriginOrRefuse("curl -s http://127.0.0.1:8100/x", "curl -s http://0.0.0.0:8100/x").ok).toBe(false);
    expect(sameOriginOrRefuse("curl -s http://127.0.0.1:8100/x", "curl -s http://127.0.0.2:8100/x").ok).toBe(false);
  });
});

describe("(f)/(g) an initial synthesis names only loopback or what the goal names", () => {
  test("(f) an invented external host the goal never named is refused", () => {
    const v = synthesisWithinInputsOrRefuse("curl -s https://dannykeane.com/developers/api | jq .", ["Run the landing audit and report how many improvement lanes it lists."]);
    expect(v.ok).toBe(false);
    expect(v.introduced).toEqual(["https://dannykeane.com:443"]);
  });
  test("(g) the IP-echo class: api.ipify.org is refused unless the goal names it", () => {
    const cmd = "curl -s 'https://api.ipify.org?format=json' | jq -r .ip";
    expect(synthesisWithinInputsOrRefuse(cmd, ["What is this node's public IP address?"]).ok).toBe(false);
    expect(synthesisWithinInputsOrRefuse(cmd, ["What public IP does api.ipify.org report for this node?"]).ok).toBe(true);
    expect(synthesisWithinInputsOrRefuse(cmd, ["Fetch https://api.ipify.org?format=json and report the ip"]).ok).toBe(true);
    // A URL literal in the goal admits exactly its own origin.
    expect(synthesisWithinInputsOrRefuse("curl -s http://api.ipify.org", ["Fetch https://api.ipify.org?format=json"]).ok).toBe(false);
  });
  test("loopback on any port is the substrate's own and stays allowed", () => {
    expect(synthesisWithinInputsOrRefuse("curl -s http://127.0.0.1:8100/registry/stats | jq .totalVessels", ["How many vessels are registered?"]).ok).toBe(true);
    expect(synthesisWithinInputsOrRefuse("curl -s http://localhost:8260/concepts/search?q=x", ["search concepts"]).ok).toBe(true);
    expect(synthesisWithinInputsOrRefuse("git -C repos/goal-host-vessel rev-list --count HEAD", ["count commits"]).ok).toBe(true);
  });
});

describe("origin parsing covers the host-bearing forms", () => {
  test.each([
    ["scheme-less curl target", "curl -s api.merlonix.com/v1/x", ["http://api.merlonix.com:80"]],
    ["curl --url", "curl --url https://evil.example/x", ["https://evil.example:443"]],
    ["curl -x proxy", "curl -s -x evil.example:3128 http://127.0.0.1:8100/x", ["http://127.0.0.1:8100", "http://evil.example:3128"]],
    ["curl --resolve redirect", "curl --resolve api.x.io:443:203.0.113.9 https://api.x.io/", ["https://api.x.io:443", "http://203.0.113.9:443"]],
    ["curl -i takes no value", "curl -i evil.example/x", ["http://evil.example:80"]],
    ["wget -O takes a value", "wget -q -O out.json http://127.0.0.1:8100/y", ["http://127.0.0.1:8100"]],
    ["wget scheme-less", "wget -qO- evil.example/x", ["http://evil.example:80"]],
    ["nc host port", "nc evil.example 80", ["tcp://evil.example:80"]],
    ["ssh user@host", "ssh -p 2222 root@evil.example uptime", ["ssh://evil.example:2222"]],
    ["git scp-style", "git clone git@github.com:x/y.git", ["ssh://github.com:22"]],
    ["git https", "git clone https://github.com/x/y.git", ["https://github.com:443"]],
    ["python urllib literal", "python3 -c \"import urllib.request;print(urllib.request.urlopen('https://evil.example/').read())\"", ["https://evil.example:443"]],
    ["bash /dev/tcp", "cat < /dev/tcp/evil.example/80", ["tcp://evil.example:80"]],
    ["userinfo stripped", "curl -s https://u:p@evil.example:8443/x", ["https://evil.example:8443"]],
    ["wrapper commands", "timeout 10 env A=1 curl -s evil.example/x", ["http://evil.example:80"]],
    ["proxy env assignment", "https_proxy=evil.example:3128 curl -s http://127.0.0.1:8100/x", ["http://127.0.0.1:8100", "http://evil.example:3128"]],
    ["exported ALL_PROXY", "export ALL_PROXY=socks5://evil.example:1080; curl -s http://127.0.0.1:8100/x", ["socks5://evil.example:1080", "http://127.0.0.1:8100"]],
    ["wget -e http_proxy", "wget -e use_proxy=yes -e http_proxy=evil.example:3128 -qO- http://127.0.0.1:8100/x", ["http://127.0.0.1:8100", "http://evil.example:3128"]],
  ])("%s", (_n, cmd, expected) => {
    expect(keys(cmd)).toEqual(expected);
  });

  test("a host built at run time is OPAQUE and refused unless the inputs carry the same token", () => {
    expect(sameOriginOrRefuse(STEP9_ORIG, "H=evil.example; curl -s $H/x").ok).toBe(false);
    expect(sameOriginOrRefuse(STEP9_ORIG, "curl -s \"{{webSearchResult.url}}\"").ok).toBe(false);
    expect(sameOriginOrRefuse(STEP9_ORIG, "curl -s https://$(cat host)/x").ok).toBe(false);
  });

  test("a pipeline's parser stages are not targets", () => {
    expect(keys("curl -s http://127.0.0.1:8100/x | jq -r '.a.b' | sort | head -n 5 > out.json")).toEqual(["http://127.0.0.1:8100"]);
  });

  test("commandOf reads the command-bearing field", () => {
    expect(commandOf({ command: "ls" })).toBe("ls");
    expect(commandOf({ script: "echo 1" })).toBe("echo 1");
    expect(commandOf({ path: "x" })).toBeUndefined();
    expect(commandOf(null)).toBeUndefined();
  });
});

describe("index.ts wires the rule into every entry where an LLM-written command is run", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
  test("it imports the helper", () => {
    expect(src).toContain('import { commandOf, sameOriginOrRefuse, synthesisWithinInputsOrRefuse } from "./command-egress";');
  });
  test("the correction loop captures the ORIGINAL command once, before the loop, and gates every re-synthesis before it is run", () => {
    const orig = src.indexOf("const _origCmd = commandOf(directArgsRaw);");
    const loop = src.indexOf("while (_deg && _tries < _correctionBudget");
    expect(orig).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(orig);
    const body = src.slice(loop, src.indexOf("RECOVERY BEFORE REFUSAL", loop));
    const gate = body.indexOf("const _egress = sameOriginOrRefuse(_origCmd, _cand, [goal]);");
    const passes = body.indexOf("if (!_banned && _egress.ok) break;");
    const merge = body.indexOf("directArgsRaw = { ...directArgsRaw, ..._reSyn };");
    const run = body.indexOf("const _re = await rawResolve(shape, ep.endpoint, ep.resolvePath, directArgs);");
    expect(gate).toBeGreaterThan(0);
    expect(passes).toBeGreaterThan(gate);
    expect(merge).toBeGreaterThan(passes);
    expect(run).toBeGreaterThan(merge);
    // Abandonment nulls the candidate, and a null candidate leaves the loop before the merge.
    expect(body.slice(passes, merge)).toContain("_reSyn = null;");
    expect(body.slice(passes, merge)).toContain("if (!_reSyn) break;");
  });
  test("the initial synthesis, the arg-correction and the action pick/retry are gated", () => {
    expect(src).toContain("const _synEgress = synthesisWithinInputsOrRefuse(commandOf(directArgsRaw), [goal]);");
    expect(src).toContain("const _acEgress = sameOriginOrRefuse(commandOf(directArgsRaw), commandOf(mergedArgs), [goal]);");
    expect(src).toContain("const corrected = !_acEgress.ok ? null : await rawResolve(");
    expect(src).toContain("const _actEgress = synthesisWithinInputsOrRefuse(commandOf(action.args), [goal]);");
    expect(src).toContain("const _retEgress = sameOriginOrRefuse(commandOf(action.args), commandOf(mergedArgs), [goal]);");
  });
});
