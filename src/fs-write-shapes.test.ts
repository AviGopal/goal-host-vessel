// Pins that BOTH walk satisfier sites refuse filesystem-write shapes. The 10-01
// breach came through the second one (the vessel-resolver producer scan), which
// called vesselResolveShape("fs_edit") while the first site already refused it.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FS_WRITE_SHAPES, isFsWriteShape } from "./fs-write-shapes";

const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

describe("filesystem-write shapes", () => {
  it("cover every file-writing tool and its result shape, and nothing read-only", () => {
    for (const s of ["fs_edit", "fs_write", "fileEditResult", "fileWriteResult", "code_replace_lines", "code_insert_after_line", "code_add_import", "codeReplaceResult", "codeInsertResult", "codeAddImportResult", "gitCommitResult"]) expect(`${s}: ${isFsWriteShape(s)}`).toBe(`${s}: true`);
    for (const s of ["fs_read", "fileContent", "shellResult", "code_read_lines", "gitDiff", "gitStatus", "git_status", "", undefined]) expect(isFsWriteShape(s)).toBe(false);
  });

  it("vesselResolveShape refuses them before it looks up any endpoint", () => {
    const start = src.indexOf("const vesselResolveShape = async (shape: string)");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("const ep = await endpointForShape(shape);", start));
    expect(body).toMatch(/if \(isFsWriteShape\(shape\)\) \{[\s\S]*?return null;/);
  });

  it("the satisfier pick uses the same set", () => {
    expect(src).toContain("const SATISFIER_FORBIDDEN_FS_WRITE = FS_WRITE_SHAPES;");
    expect(FS_WRITE_SHAPES.has("fs_edit")).toBe(true);
  });
});
