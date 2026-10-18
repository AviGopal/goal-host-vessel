// THE WRITE DOORS: a filesystem-write shape (fs-write-shapes.ts) is picked, composed or targeted
// ONLY on a goal ADMITTED as a change.
//
// Measured: "Without modifying anything, describe what edits <file> would need." was inferred
// ["fs_edit"], and the walk ran auto-bridge-fs_edit twice against the live tree — an ordinary
// template pick, then the composite path ("COMPOSED existing capability … missing_target"). Only
// a downstream path guard stopped it. FS_WRITE_SHAPES held at the satisfier and vesselResolve
// and nowhere a template or composite was chosen, so inference alone could open a write.
//
// Admission is structural, never read from the goal's wording: either the dispatch entered the
// edit-intent route to feature_compose (the routing rules' own decision), or the CALLER declared
// a write shape in expected_output_shapes. goal-host has no other structured write field, so the
// caller-declared shapes are that signal. A not-admitted goal loses the write candidate/target
// here, and every drop is recorded (tagged line) and counted (writeDoorCounters, on /health).
//
// The satisfier and vesselResolve doors stay unconditional: a walk-side write is uncreditable
// without a landed sha whatever the admission, so they only count their refusals here.
import { isFsWriteShape } from "./fs-write-shapes";

export const isWriteShape = isFsWriteShape;

export interface WriteDoorContext {
  /** The dispatch was handed to feature_compose by the early edit-intent route. */
  admittedEditRoute: boolean;
  /** The caller's own expected_output_shapes, before any inference. */
  declaredOutputShapes?: readonly string[] | null;
}

export function callerDeclaresWrite(declared: readonly string[] | null | undefined): boolean {
  return Array.isArray(declared) && declared.some((s) => isWriteShape(s));
}

export function admittedChange(ctx: WriteDoorContext): boolean {
  return ctx.admittedEditRoute === true || callerDeclaresWrite(ctx.declaredOutputShapes);
}

export type WriteDoor =
  | "target" | "template_pick" | "composite_pick" | "bridge_pick" | "recovery_pick"
  | "satisfier" | "vessel_resolve";

const counters: Record<WriteDoor, number> = {
  target: 0, template_pick: 0, composite_pick: 0, bridge_pick: 0, recovery_pick: 0,
  satisfier: 0, vessel_resolve: 0,
};
export function writeDoorCounters(): Readonly<Record<WriteDoor, number>> { return { ...counters }; }
export function resetWriteDoorCounters(): void { for (const k of Object.keys(counters) as WriteDoor[]) counters[k] = 0; }
/** The unconditional doors (satisfier, vesselResolve) count their refusals here. */
export function noteWriteRefusal(door: WriteDoor, n = 1): void { counters[door] += n; }

export function writeDropLine(door: WriteDoor, dropped: readonly string[], goalHash: string): string {
  return `[write-door] dropped ${dropped.join(",")}: goal not admitted as a change (door=${door}, goal_hash=${goalHash})`;
}

/**
 * Keep every item that writes nothing; keep a writing item only when the goal is admitted.
 * An item writes when any shape `shapesOf` returns is a write shape (a producer's outputs, or a
 * target shape itself). Each dropped item is counted and named in one recorded line.
 */
export function writeDoorFilter<T>(
  items: readonly T[],
  shapesOf: (item: T) => readonly string[],
  admitted: boolean,
  door: WriteDoor,
  goalHash: string,
  record?: (line: string) => void,
  nameOf: (item: T) => string = (item) => String(item),
): T[] {
  if (admitted) return [...items];
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const item of items) {
    if (shapesOf(item).some((s) => isWriteShape(s))) dropped.push(nameOf(item));
    else kept.push(item);
  }
  if (dropped.length > 0) {
    counters[door] += dropped.length;
    record?.(writeDropLine(door, dropped, goalHash));
  }
  return kept;
}

/** A door's admission, carried to a picker that runs outside the walk (the recovery loop's recommend). */
export interface WriteDoorPass { admitted: boolean; goalHash: string; record?: (line: string) => void }

/** The target form: a list of shapes, each its own item. */
export function writeDoorShapes(shapes: readonly string[], admitted: boolean, door: WriteDoor, goalHash: string, record?: (line: string) => void): string[] {
  return writeDoorFilter(shapes, (s) => [s], admitted, door, goalHash, record);
}
