/**
 * Closed shape vocabulary the judge core and the walk read when they RECORD evidence (which writes a run
 * made) and when they render reason text. The open rules keep their own copy for their decisions; this one
 * cannot be changed by an open edit, so the evidence a verdict is judged on is not lane-editable.
 */
import { isStoreWriteShape } from "../resolve-pointer";
import { FS_WRITE_SHAPES } from "../fs-write-shapes";

/** Shapes whose production IS a mutation: a store write, a filesystem/code write, or an *_update/_create/_delete. */
export function isMutationShape(shape: string): boolean {
  return isStoreWriteShape(shape) || FS_WRITE_SHAPES.has(shape) || /_(?:update|create|delete)$/.test(shape);
}

/** Prose sinks: a write here stores TEXT (a note, a concept). */
export const PROSE_SINK_SHAPES: ReadonlySet<string> = new Set([
  "concept_write", "concept_create_write", "memoryNote_write", "write_note", "obsidian:write_note",
]);
