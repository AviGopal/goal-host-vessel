// COMMAND EGRESS — an LLM-synthesised executor command never reaches an origin its inputs did not name.
//
// The walk's executor path asks an LLM for a command and runs it (local-tools runs it as `bash -c`
// inside the substrate). Twice the model was free to choose the network address:
//
//   - the INITIAL synthesis (pointer_arg_extraction), and
//   - every SELF-CORRECTION re-synthesis, which rewrites a failing command with the failure fed back.
//
// The only code check was a ban on hosts already proven to refuse us. A rewrite could therefore
// replace a local endpoint with an invented external one and run it. Observed on node1 (dispatch
// 28a669b3): step 9 went `curl -s http://127.0.0.1:8100/landing-paths/audit…` →
// `curl -s https://api.merlonix.com/v1/public/landing-paths/audit…` → `https://internetvitals.com/
// api/v1/health`; step 52 went `127.0.0.1:8100/landing/audit` → `dannykeane.com/developers/api` →
// `api.github.com/repos/your/repository/commits?since=…` → `api.merlonix.com/v1/public/
// improvement-lane-status?since=…` → `merlonix.com/docs/public-api/`. Every one of those hosts was
// invented by the model and executed from inside the substrate.
//
// THE RULE. A synthesised command passes only if every network origin (scheme, host, port) it names
// is already in its inputs:
//   - a CORRECTION: the origins of the ORIGINAL command of that executor call (the first command,
//     not the previous attempt), plus the origins the goal text names. Loopback stays loopback on the
//     same scheme and port; it never gains a new port. An original with no origin admits none.
//   - an INITIAL synthesis: the origins the goal text names, plus loopback on any port (the
//     substrate's own vessels live there, and a goal does not spell out their ports).
// Loopback equivalence: 127.0.0.1 ≡ localhost ≡ [::1] on the same scheme and port.
// A host named bare in the goal text (`api.ipify.org`, `ssd.jpl.nasa.gov:8443`) admits that host on
// http and https, at the default ports or the port it was named with. A URL literal in the goal
// admits exactly its own origin.
//
// A violating candidate is REFUSED WITHOUT BEING RUN; the caller never executes it. This module only
// decides; it never runs, fetches or resolves anything.
//
// WHAT IS PARSED (from a shell command string):
//   - URL literals `scheme://[user@]host[:port]` anywhere, including inside quotes and inside
//     `python -c "...urllib.request.urlopen('https://…')"` style one-liners;
//   - curl/wget positional targets without a scheme (`curl api.x.com/v1`, `curl 127.0.0.1:8100/x`,
//     curl's default scheme is http), and the values of their host-bearing flags (--url, -x/--proxy,
//     --preproxy, --resolve, --connect-to);
//   - nc/ncat/netcat/telnet `host port`; ssh/sftp `[user@]host` (-p port); scp/rsync/git scp-style
//     `user@host:path`; bash `/dev/tcp/host/port` and `/dev/udp/host/port`; proxies named through
//     the environment (`http_proxy=`, `https_proxy=`, `ALL_PROXY=`, … including `wget -e`).
// A target whose host is built at run time (`$VAR`, `$(…)`, backticks, a `{{shape}}` placeholder) is
// an OPAQUE origin: it is admitted only if the same token appears verbatim in the inputs.
//
// NOT COVERED (documented, not detected): hosts assembled by string operations or decoding (base64,
// printf, rev), hosts read from files or stdin, URLs fetched by an interpreter without a URL literal
// (`python -c "socket.create_connection((h, 80))"` with h computed), DNS-only tools (dig, host,
// nslookup, ping), URL lists read by `wget -i file`, flags of other network clients (httpie `http`, aria2c, lynx, openssl s_client
// -connect, socat), and values of curl/wget flags not listed below that take an argument (a value
// that looks like a host would then be read as a target — that errs toward refusal).

/** One network origin. `host` is lowercased, unbracketed; `loopback` marks the 127.0.0.1/localhost/::1 class. */
export interface Origin { scheme: string; host: string; port: number; loopback: boolean; opaque: boolean }

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443, ftp: 21, ftps: 990, sftp: 22, ssh: 22, git: 9418, tcp: 0, udp: 0 };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const OPAQUE = /[$`{}]/;

function mkOrigin(scheme: string, host: string, port: number | null): Origin | null {
  let h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return null;
  const s = scheme.toLowerCase();
  return { scheme: s, host: h, port: port ?? DEFAULT_PORT[s] ?? 0, loopback: LOOPBACK_HOSTS.has(h), opaque: OPAQUE.test(h) };
}

/**
 * The canonical key: the loopback aliases collapse to 127.0.0.1 (an address no other host can
 * spell), an opaque target keeps its raw token.
 */
export function originKey(o: Origin): string {
  return `${o.scheme}://${o.loopback ? "127.0.0.1" : o.host}:${o.port}`;
}

/** Parse `[user@]host[:port]` (IPv6 in brackets). Returns null when no host is present. */
function parseAuthority(scheme: string, authority: string, defaultPort: number | null = null): Origin | null {
  let a = authority;
  const at = a.lastIndexOf("@");
  if (at >= 0) a = a.slice(at + 1);
  let host = a, port: number | null = defaultPort;
  if (a.startsWith("[")) {
    const close = a.indexOf("]");
    if (close < 0) return null;
    host = a.slice(0, close + 1);
    const rest = a.slice(close + 1);
    if (/^:\d+$/.test(rest)) port = Number(rest.slice(1));
  } else {
    const m = a.match(/^(.*?)(?::(\d+))?$/);
    host = m?.[1] ?? a;
    if (m?.[2]) port = Number(m[2]);
  }
  return mkOrigin(scheme, host, port);
}

const URL_LITERAL = /\b([a-z][a-z0-9+.-]*):\/\/([^\s'"<>\\/?#|;&()]*)/gi;

/** Origins of every `scheme://authority` literal in the text. */
function urlLiteralOrigins(text: string): Origin[] {
  const out: Origin[] = [];
  for (const m of text.matchAll(URL_LITERAL)) {
    const scheme = (m[1] ?? "").toLowerCase();
    if (scheme === "file") continue; // no network authority
    const o = parseAuthority(scheme, m[2] ?? "");
    if (o) out.push(o);
  }
  return out;
}

// A host-looking token: a dotted name ending in a letter label, an IPv4 address, localhost or a
// bracketed IPv6, with an optional port and path. `out.json` matches too — fail-closed.
const HOSTLIKE = /^(?:[a-z0-9_-]+@)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*|\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[0-9a-f:.]+\])(?::(\d+))?(?:[/?#].*)?$/i;

function bareTarget(scheme: string, token: string, defaultPort: number | null = null): Origin | null {
  if (token.includes("://")) return null; // a URL literal: already counted
  if (OPAQUE.test(token)) return { scheme, host: token.toLowerCase(), port: defaultPort ?? DEFAULT_PORT[scheme] ?? 0, loopback: false, opaque: true };
  const m = token.match(HOSTLIKE);
  if (!m) return null;
  return mkOrigin(scheme, m[1] ?? "", m[2] ? Number(m[2]) : defaultPort);
}

/** Split a command into segments of words: quotes respected, `| ; & && || ( ) < >` and newlines separate. */
function segments(cmd: string): string[][] {
  const segs: string[][] = [];
  let words: string[] = [], cur = "", inWord = false, q: string | null = null;
  const endWord = () => { if (inWord) words.push(cur); cur = ""; inWord = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; inWord = true; continue; }
    if (/\s/.test(c)) { if (c === "\n") endSeg(); else endWord(); continue; }
    if ("|;&()<>".includes(c)) { endSeg(); continue; }
    cur += c; inWord = true;
  }
  endSeg();
  return segs;
}

// curl/wget flags that take a separate value. Host-bearing ones are parsed for an origin.
const CURL_HOST_FLAGS = new Set(["--url", "-x", "--proxy", "--preproxy", "--resolve", "--connect-to"]);
const CURL_ARG_FLAGS = new Set([
  "-o", "--output", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json",
  "-X", "--request", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-w", "--write-out", "-m", "--max-time",
  "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "-b", "--cookie", "-c", "--cookie-jar", "-F", "--form",
  "-r", "--range", "-T", "--upload-file", "-K", "--config", "-y", "--speed-time", "-Y", "--speed-limit", "--limit-rate",
  "-z", "--time-cond", "--cacert", "--cert", "--key", "-E", "--interface", "--dns-servers", "--max-filesize", "-D", "--dump-header",
  "--output-document", "-P", "--directory-prefix", "-U", "-t", "--tries", "--timeout", "--wait", "--append-output",
  ...CURL_HOST_FLAGS,
]);
// Short flags that take a value, per client: the same letter differs (curl -O/-i/-a take none and
// curl -x is a proxy; wget -O/-i/-a take one and wget -x takes none).
const CURL_SHORT_ARG = new Set("oHdXuAewmbcFrTKyYzEDPUt".split(""));
const WGET_SHORT_ARG = new Set("OoaiPUtTwQeBlARDIXY".split(""));

function hostFlagOrigins(flag: string, value: string): Origin[] {
  if (flag === "--resolve" || flag === "--connect-to") {
    // --resolve host:port:addr  --connect-to host1:port1:host2:port2 — the address actually dialled.
    const parts = value.split(":");
    const tail = flag === "--resolve" ? parts.slice(2).join(":") : parts.slice(2, 3).join("");
    const port = flag === "--resolve" ? Number(parts[1]) || null : Number(parts[3]) || null;
    const o = tail ? mkOrigin("http", tail, port) : null;
    if (o) o.opaque = o.opaque || OPAQUE.test(tail);
    return o ? [o] : [];
  }
  const lit = urlLiteralOrigins(value);
  if (lit.length) return lit;
  const b = bareTarget("http", value);
  return b ? [b] : [];
}

function curlLikeOrigins(words: string[]): Origin[] {
  const out: Origin[] = [];
  const isCurl = (words[0] ?? "").replace(/^.*\//, "") === "curl";
  const shortArg = isCurl ? CURL_SHORT_ARG : WGET_SHORT_ARG;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq >= 0 ? w.slice(0, eq) : w;
      if (eq >= 0) { if (CURL_HOST_FLAGS.has(name)) out.push(...hostFlagOrigins(name, w.slice(eq + 1))); continue; }
      if (CURL_ARG_FLAGS.has(name)) { const v = words[++i] ?? ""; if (CURL_HOST_FLAGS.has(name)) out.push(...hostFlagOrigins(name, v)); }
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      // A cluster of short flags: the first one that takes a value consumes the rest, or the next word.
      for (let k = 1; k < w.length; k++) {
        const f = w[k]!;
        const proxy = isCurl && f === "x";
        if (proxy || shortArg.has(f)) {
          const v = k + 1 < w.length ? w.slice(k + 1) : (words[++i] ?? "");
          if (proxy) out.push(...hostFlagOrigins("-x", v));
          break;
        }
      }
      continue;
    }
    const b = bareTarget("http", w);
    if (b) out.push(b);
  }
  return out;
}

const NC_ARG = new Set(["-w", "-p", "-s", "-i", "-q", "-x", "-X", "-e", "-c", "-W", "-O", "-I"]);
function ncOrigins(words: string[]): Origin[] {
  const pos: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) { if (NC_ARG.has(w)) i++; continue; }
    pos.push(w);
  }
  if (!pos.length) return [];
  const port = pos[1] && /^\d+$/.test(pos[1]) ? Number(pos[1]) : null;
  const o = bareTarget("tcp", pos[0]!, port);
  return o ? [o] : [];
}

const SSH_ARG = new Set(["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-E", "-m", "-O", "-Q", "-S", "-w", "-B", "-e"]);
function sshOrigins(words: string[]): Origin[] {
  let port: number | null = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) {
      if (w === "-p" || w === "-P") { port = Number(words[i + 1]) || null; i++; continue; }
      if (SSH_ARG.has(w)) i++;
      continue;
    }
    const o = bareTarget("ssh", w.replace(/:.*$/, ""), port);
    return o ? [o] : [];
  }
  return [];
}

// `user@host:path` (scp, rsync, git) and bash `/dev/tcp/host/port`.
const SCP_LIKE = /(?:^|[\s'"=])[a-z0-9._-]+@((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*|\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[0-9a-f:.]+\]):(?!\/\/)/gi;
const DEV_TCP = /\/dev\/(tcp|udp)\/([^/\s'"]+)\/(\d+)/gi;
// A proxy named through the environment (`https_proxy=… curl …`, `export ALL_PROXY=…`,
// `wget -e http_proxy=…`): the client dials the proxy, so its address is an origin.
const PROXY_ENV = /(?:^|[\s;'"=])((?:https?|all|ftp|socks|rsync)_proxy)=['"]?([^\s;'"&|()]+)/gi;

/** Every network origin a shell command names. Pure; never runs anything. */
export function originsOfCommand(cmd: string | null | undefined): Origin[] {
  if (!cmd || typeof cmd !== "string") return [];
  const out: Origin[] = [...urlLiteralOrigins(cmd)];
  for (const m of cmd.matchAll(SCP_LIKE)) { const o = mkOrigin("ssh", m[1] ?? "", null); if (o) out.push(o); }
  for (const m of cmd.matchAll(PROXY_ENV)) out.push(...hostFlagOrigins("--proxy", m[2] ?? ""));
  for (const m of cmd.matchAll(DEV_TCP)) { const o = mkOrigin(m[1] ?? "tcp", m[2] ?? "", Number(m[3])); if (o) { o.opaque = OPAQUE.test(m[2] ?? ""); out.push(o); } }
  for (const words of segments(cmd)) {
    // The command word, past env assignments and common wrappers (sudo, timeout 10, env, nice, …).
    let i = 0;
    while (i < words.length) {
      const w = words[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || ["sudo", "env", "nice", "nohup", "command", "exec", "time", "stdbuf"].includes(w)) { i++; continue; }
      if (w === "timeout") { i += 2; continue; }
      break;
    }
    const rest = words.slice(i);
    const name = (rest[0] ?? "").replace(/^.*\//, "");
    if (name === "curl" || name === "wget") out.push(...curlLikeOrigins(rest));
    else if (["nc", "ncat", "netcat", "telnet"].includes(name)) out.push(...ncOrigins(rest));
    else if (name === "ssh" || name === "sftp") out.push(...sshOrigins(rest));
  }
  const seen = new Set<string>();
  return out.filter((o) => { const k = originKey(o); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Origins a goal (or any input text) NAMES: URL literals exactly, bare hostnames on http and https. */
export function originsOfText(text: string | null | undefined): Origin[] {
  if (!text || typeof text !== "string") return [];
  const out: Origin[] = urlLiteralOrigins(text);
  const bare = /(?<![\w@.\/-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*|\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::(\d+))?(?![\w-])/gi;
  for (const m of text.matchAll(bare)) {
    const port = m[2] ? Number(m[2]) : null;
    for (const s of ["http", "https"]) { const o = mkOrigin(s, m[1] ?? "", port); if (o) out.push(o); }
  }
  return out;
}

export interface EgressVerdict {
  ok: boolean;
  /** Candidate origins not admitted by the inputs (canonical keys). Empty when ok. */
  introduced: string[];
  /** Origins the inputs admit (canonical keys). */
  allowed: string[];
}

function verdict(candidate: string | null | undefined, allowed: Origin[], anyLoopback: boolean): EgressVerdict {
  const allowedKeys = new Set(allowed.map(originKey));
  // An opaque target is admitted only by the identical token in the inputs.
  const allowedOpaque = new Set(allowed.filter((o) => o.opaque).map((o) => o.host));
  const introduced: string[] = [];
  for (const o of originsOfCommand(candidate)) {
    const k = originKey(o);
    if (o.opaque ? allowedOpaque.has(o.host) : (allowedKeys.has(k) || (anyLoopback && o.loopback))) continue;
    if (!introduced.includes(k)) introduced.push(k);
  }
  return { ok: introduced.length === 0, introduced, allowed: [...allowedKeys] };
}

/**
 * A CORRECTION of `original`: passes only if every origin `candidate` names is one `original` names
 * (loopback aliases equivalent, same scheme and port), or one the `inputs` (the goal text) name.
 * With no origin in `original` or the inputs, the candidate may name none.
 */
export function sameOriginOrRefuse(original: string | null | undefined, candidate: string | null | undefined, inputs: Array<string | null | undefined> = []): EgressVerdict {
  return verdict(candidate, [...originsOfCommand(original), ...inputs.flatMap((t) => originsOfText(t))], false);
}

/**
 * An INITIAL synthesis (no prior command): passes only if every non-loopback origin the candidate
 * names is one the `inputs` (the goal text) name. Loopback is admitted on any port.
 */
export function synthesisWithinInputsOrRefuse(candidate: string | null | undefined, inputs: Array<string | null | undefined>): EgressVerdict {
  return verdict(candidate, inputs.flatMap((t) => originsOfText(t)), true);
}

/** The command-bearing field of a pointer-args object, if any (command, cmd, script, sql). */
export function commandOf(args: Record<string, unknown> | null | undefined): string | undefined {
  if (!args) return undefined;
  return (["command", "cmd", "script", "sql"] as const).map((k) => args[k]).find((v) => typeof v === "string") as string | undefined;
}
