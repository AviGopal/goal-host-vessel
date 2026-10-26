import { describe, test, expect } from "bun:test";
import * as mod from "../../src/index";

describe("walk live shape set: self-visibility", () => {
  // The defect described is that the internal `liveShapes()` function, used to determine
  // which shapes are available for use, incorrectly includes the `output_shapes` of
  // *all* non-retired activities. This makes a shape appear "live" or "reachable"
  // simply because an activity *plans* to produce it, even if no concrete producer/resolver
  // for that shape is actually registered in discovery.
  //
  // For example, an activity for a template `auto-bridge-shellResult` makes the output shape
  // `shellResult` appear live, which is incorrect. An activity is a plan, not a producer.
  //
  // This test exercises `floorJudgedShapes`, an exported function whose behavior is
  // influenced by the internal `liveShapes` set. `floorJudgedShapes` is expected to
  // filter a list of target shapes, returning only those that are genuinely "live" or
  // otherwise judged as reachable.

  test("failing: an activity's output shape should not be counted as live on its own", () => {
    // `shellResult` is a common output shape of an `auto-bridge` activity.
    // The defect causes this shape to be incorrectly included in the internal `liveShapes` set.
    const activityOutputShape = "shellResult";

    // We call `floorJudgedShapes` with this shape. If the function consults the defective
    // `liveShapes` set, it will incorrectly consider `shellResult` to be live.
    const judgedShapes = mod.floorJudgedShapes(
      [activityOutputShape],
      new Set<string>(), // no writes were called
      [] // no tools were executed
    );

    // THE ASSERTION:
    // The correct behavior is that `shellResult` should NOT be considered live just because
    // an activity exists that *might* produce it. Therefore, `floorJudgedShapes` should
    // return an empty array, not containing `shellResult`.
    //
    // This `expect` call asserts the correct behavior. It will FAIL because the defect causes
    // `judgedShapes` to be `['shellResult']`, which *does* contain the shape.
    expect(judgedShapes).not.toContain(activityOutputShape);
  });

  test("control: a shape that is not live and not an activity output is correctly excluded", () => {
    const nonExistentShape = "shape-that-is-not-real-and-never-was";

    const judgedShapes = mod.floorJudgedShapes(
      [nonExistentShape],
      new Set<string>(),
      []
    );

    // This shape is neither a registered producer nor an activity output. The function
    // should correctly exclude it. This test must pass both before and after the fix.
    expect(judgedShapes).not.toContain(nonExistentShape);
  });
});
