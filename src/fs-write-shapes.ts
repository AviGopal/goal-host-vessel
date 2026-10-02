// The filesystem-WRITE shapes a walk must never produce by itself.
//
// A walk that "resolves" one of these through a vessel does not resolve anything:
// the vessel performs the write, live, with no snapshot, verification or rollback,
// and the reach gate can never credit it (an edit-effect reach needs a landed sha).
// Edits belong on the drafter paths (feature_compose, patch_with_tools), which
// verify, can undo themselves, and land through the lane.
//
// The walk has two satisfier construction sites — the satisfier pick and the
// vessel-resolver producer scan (gap walk-blind-to-vessel-resolver-producers) —
// and the rule held only at the first. On 10-01 the second injected fs_edit
// against local-tools for a goal that named
// repos/development-vessel/src/resolvers/gap-to-feature.ts; the LLM-synthesised
// path was scripts/substrate/substrate-pull-sync.sh, the write landed in the live
// super-repo clone, and pull-sync installed it. Over the 14 days before, that scan
// injected 96 fs_edit, 11 fileEditResult and 9 fs_write steps. One set, checked
// where the vessel resolve happens, so both sites agree.
export const FS_WRITE_SHAPES: ReadonlySet<string> = new Set([
  "fs_edit", "fs_write", "fileEditResult", "fileWriteResult",
  "code_replace_lines", "code_insert_after_line", "code_add_import",
  "codeReplaceResult", "codeInsertResult", "codeAddImportResult",
  // A commit is a write too, and the one pull-sync trusts most (it installs from HEAD).
  "gitCommitResult",
]);

export function isFsWriteShape(shape: unknown): boolean {
  return typeof shape === "string" && FS_WRITE_SHAPES.has(shape);
}
