import { describe, it, expect } from "bun:test";
import { writeDoorFilter } from "../../src/write-door.js";

describe("writeDoorFilter", () => {
  it("drops a candidate with a change shape on an unadmitted goal", () => {
    const items = ["item-with-change"];
    const shapesOf = (item: string) =>
      item === "item-with-change" ? ["fileEditResult"] : [];
    const admitted = false;
    const door = "template_pick";
    const goalHash = "test-hash";
    const record = () => {};

    const kept = writeDoorFilter(
      items,
      shapesOf,
      admitted,
      door,
      goalHash,
      record
    );
    expect(kept).toEqual([]);
  });

  it("keeps a learned composition whose store write is outside the goal's product when goal not admitted", () => {
    const items = ["learned-composition"];
    const shapesOf = (item: string) =>
      item === "learned-composition"
        ? ["someReadShape", "memoryNote_write"]
        : [];
    const admitted = false;
    const door = "template_pick";
    const goalHash = "test-hash";
    const record = () => {};
    const goalProduct = new Set(["someReadShape"]);

    const kept = writeDoorFilter(
      items,
      shapesOf,
      admitted,
      door,
      goalHash,
      record,
      (item) => item,
      goalProduct
    );
    // After the fix, this must hold: writeDoorFilter on a goal not admitted, given one candidate whose shapes are [<a read shape in the goal product>, memoryNote_write] and a goal product that contains only the read shape, keeps a usable form of that candidate (the candidate is not returned as dropped).
    expect(kept).toEqual(["learned-composition"]);
  });
});
