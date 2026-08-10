// Pins the two-envelope unwrap for /v2/impulses/resolve answers.
//
// THE DEFECT: `feature_compose` and `patch_with_tools` are advertised libp2p-only,
// so the edit-intent route always received the PROXIED envelope, which carries the
// report at `content.body` and has no top-level `body`. The old unwrap
// (`j.body ?? j`) fell through to the whole response, found no `verdict`, and every
// goal-dispatched edit was abandoned with `verdict=(none)` — while the compose had
// actually run and returned a real verdict. The gap-compose lane was unaffected
// because it calls the resolver in-process.

import { describe, expect, it } from "bun:test";
import { resolveReportBody } from "./resolve-report-body";

describe("resolveReportBody", () => {
  it("reads the DIRECT envelope (in-process / plain http vessel)", () => {
    const direct = {
      success: true,
      shape: "featureComposeReport",
      body: { ok: false, verdict: "REFUSED", stage: "scope" },
    };
    expect(resolveReportBody(direct).verdict).toBe("REFUSED");
  });

  it("reads the PROXIED envelope — the regression this exists for", () => {
    const proxied = {
      content: {
        shape: "feature_compose",
        produced_by: "development-vessel-local@federation-transport-vessel@spoke-cfda39e7",
        body: { ok: false, verdict: "REFUSED", stage: "scope" },
        note: "proxied to the owning vessel on the peer substrate over libp2p",
      },
      metadata: { shape: "feature_compose" },
    };
    expect(resolveReportBody(proxied).verdict).toBe("REFUSED");
  });

  it("carries FAVORABLE and its cutovers through the proxy", () => {
    const proxied = {
      content: {
        body: {
          verdict: "FAVORABLE",
          cutovers: [{ result: { push_status: "pushed", new_git_sha: "abc123" } }],
        },
      },
      metadata: {},
    };
    const body = resolveReportBody(proxied);
    expect(body.verdict).toBe("FAVORABLE");
    expect(Array.isArray(body.cutovers)).toBe(true);
  });

  it("prefers a direct body over a content sibling when both are present", () => {
    const both = { body: { verdict: "DIRECT" }, content: { body: { verdict: "NESTED" } } };
    expect(resolveReportBody(both).verdict).toBe("DIRECT");
  });

  it("falls back to content itself when content carries the fields flat", () => {
    expect(resolveReportBody({ content: { verdict: "FLAT" } }).verdict).toBe("FLAT");
  });

  it("preserves the old last-resort behaviour: the response itself", () => {
    expect(resolveReportBody({ verdict: "BARE" }).verdict).toBe("BARE");
  });

  it("never throws on junk, and yields no verdict", () => {
    for (const junk of [null, undefined, 42, "str", [] as unknown]) {
      expect(resolveReportBody(junk).verdict).toBeUndefined();
    }
  });

  it("does not mistake an array content for a report object", () => {
    expect(resolveReportBody({ content: [1, 2, 3] }).verdict).toBeUndefined();
  });
});
