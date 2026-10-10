import { describe, it, expect } from "bun:test";
import {
  OPERATOR_AUTHORIZATION_HEADER,
  operatorCredentialFromRequest,
  operatorCredentialHeaders,
  isLoopbackUrl,
} from "../src/operator-credential";

/**
 * goal-host carries an operator-origin request's own ApiKey to a loopback feature_compose call as
 * X-Operator-Authorization, so development-vessel can ask identity whether that key carries
 * "operator:direct". goal-host decides nothing from it. Fixture header values only.
 */

const OP = "ApiKey op-key-fixture";
const LOCAL = "http://127.0.0.1:8090/v2/impulses/resolve";

describe("operator credential forwarding", () => {
  it("forwards the operator-origin request's ApiKey to a loopback compose endpoint, unchanged", () => {
    expect(operatorCredentialHeaders({ operatorOrigin: true, operatorCredential: OP }, LOCAL)).toEqual({ [OPERATOR_AUTHORIZATION_HEADER]: OP });
    expect(operatorCredentialHeaders({ operatorOrigin: true, operatorCredential: OP }, "http://localhost:8090/x")).toEqual({ [OPERATOR_AUTHORIZATION_HEADER]: OP });
  });

  it("forwards nothing for an autonomous dispatch, even with a credential", () => {
    expect(operatorCredentialHeaders({ operatorOrigin: false, operatorCredential: OP }, LOCAL)).toEqual({});
    expect(operatorCredentialHeaders({ operatorCredential: OP }, LOCAL)).toEqual({});
  });

  it("never sends the operator's key to a non-loopback (peer node) compose endpoint", () => {
    for (const u of ["http://syzygy.host:18090/v2/impulses/resolve", "http://10.0.0.5:8090/x", "http://host.containers.internal:18090/x", "not a url"]) {
      expect(operatorCredentialHeaders({ operatorOrigin: true, operatorCredential: OP }, u)).toEqual({});
    }
  });

  it("forwards only an ApiKey credential (no Bearer, no bare key, nothing when absent)", () => {
    expect(operatorCredentialFromRequest("Bearer x.y.z")).toBeUndefined();
    expect(operatorCredentialFromRequest("op-key-fixture")).toBeUndefined();
    expect(operatorCredentialFromRequest(null)).toBeUndefined();
    expect(operatorCredentialFromRequest(OP)).toBe(OP);
    expect(operatorCredentialHeaders({ operatorOrigin: true, operatorCredential: "Bearer x.y.z" }, LOCAL)).toEqual({});
    expect(operatorCredentialHeaders({ operatorOrigin: true }, LOCAL)).toEqual({});
  });

  it("loopback means 127/8, ::1 and localhost only", () => {
    expect(isLoopbackUrl("http://127.0.0.1:1/")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1/")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.2:1/")).toBe(false);
  });

  it("index.ts carries the request's Authorization into opts and onto BOTH feature_compose calls", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(src).toContain('operatorCredential: trigger === "operator" ? operatorCredentialFromRequest(req.headers.get("authorization")) : undefined');
    expect(src).toContain("...operatorCredentialHeaders(opts, earlyComposeUrl)");
    expect(src).toContain("...operatorCredentialHeaders(opts, composeUrl)");
    // every feature_compose call site that sends directed also sends the credential header
    const directedSites = src.split("directed: opts.operatorOrigin === true").length - 1;
    const headerSites = src.split("...operatorCredentialHeaders(opts, ").length - 1;
    expect(directedSites).toBe(2);
    expect(headerSites).toBe(directedSites);
  });
});
