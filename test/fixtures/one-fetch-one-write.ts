// Positive control for import-effects.test.ts: exactly one network call and one file write, through the same API
// styles index.ts and its dependencies use (global fetch; a NAMED import from node:fs/promises). Under the effect
// recorder both are recorded and refused; the write target is inside the child's scratch HOME either way.
import { appendFile } from "node:fs/promises";

await fetch("http://127.0.0.1:9/effect-recorder-control").catch(() => {});
await appendFile(`${process.env.HOME}/effect-recorder-control.txt`, "x").catch(() => {});
