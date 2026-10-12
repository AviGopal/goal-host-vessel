# Verdict diff (BUILD 7 DESIGN §4.2)

The verdict diff replays a corpus of walk/judge scenarios hermetically against goal-host's
`src/index.ts`. Each replay records, as canonical JSON:

- every outbound request, in order (sink writes, resolves and LLM calls);
- every spawn;
- each step's verdict.

A tree passes when its record equals the committed golden byte for byte. The golden comes from the
base tree, the commit the judge/walk split starts from. Any difference fails, including a
difference in order.

## Commands

Run every command from the goal-host root.

| Purpose | Command |
|---|---|
| Regenerate the golden on the current base | `bun test/judge-split/verdict-diff/run.ts generate` |
| Compare a split tree with this harness | `bun test/judge-split/verdict-diff/run.ts check --tree <split root>` |
| Write a run's outputs, including captured console | `bun test/judge-split/verdict-diff/run.ts out <dir> [--tree <root>]` |
| Suite test | `bun test ./test/judge-split/verdict-diff.check.ts` (host only; never in the gate suite) |
| Typecheck the harness | `bunx tsc -p test/judge-split/verdict-diff/tsconfig.vd.json` |

To find where a difference starts, run `out` on both trees and `diff -r` the two directories.
Read the first differing line. Each call advances the virtual clock, so one extra read shifts every
later timestamp.

## What the golden gates

The golden includes the walk log and the decision-marker lines. A split that renames a log string
therefore shows as a difference. A pure move keeps log strings unchanged.

## The verdict-corpus status fixture

After importing the tree's `src/index.ts`, the child gives the tree's credit hold (`src/judge/credit-hold.ts`, the
same module instance) a fresh runner status that holds nothing, through its `configureCreditHold({ reader })` seam,
whatever the tree reads its status from. The status is deterministic: a fixed `run_at` and a period no virtual run
outlives. The golden records behaviour from before any credit hold existed, so the comparison is like with like.
The hold itself (fail-closed with no status, holds from red cases) is pinned by `test/verdict-corpus/`, not by this
golden. A tree without the module is unchanged.

## Environment

`golden-environment.json` records the bun version and the executor (`@avigopal/ias-executor-ts`)
version and dist hash.

- **Same executor version and bun, different build hash:** a warning is printed and the byte test
  still runs. A build change that matters can then cause a rare false failure, never a false pass.
- **Different executor version or bun:** the byte test FAILS, naming the difference (it cannot judge
  that runtime; a skip would read as a pass).

## Scenarios are the source of truth

`scenarios/*.json` are the source of truth. `gen_scenarios.py` is the script that first wrote them,
kept so a family can be extended consistently. If you edit it, run it, review the JSON diff, then
regenerate the golden.

## Expected differences that are not regressions

- **`goalHashOf` changes.** The boot scenarios `boot-reconcile-favorable-landed` and
  `boot-reconcile-staged` hard-code the goal hash `40ab3a24`, which is `goalHashOf(BOOT_EDIT_GOAL)`.
  It names the seeded compose report `route-edit-40ab3a24-compose-report.json`. If `goalHashOf` in
  `src/goal-target-inference.ts` changes, those scenarios no longer find their report. They then show
  as differences, because they fall to the "interrupted" branch. That is expected, not a regression:
  update `H_EDIT` in `gen_scenarios.py`, regenerate the scenarios, then regenerate the golden.
- **The base moves.** Regenerate the golden on the new base before the first move commit.

## Isolation

Each scenario runs in its own bun process, because `index.ts` module state survives a re-import.

- **Boot.** Boot is guarded by `import.meta.main`, so it does not run.
- **fs.** Paths under `/workspace` and `/vessels` are redirected into a scratch dir. The child
  refuses to run if either path exists on the host.
- **Stubs.** fetch and spawn are stubbed; there is no network, DB or credential access.
- **Clock and ids.** The clock is virtual; ids and `Math.random` are seeded.
- **Exports.** A Bun loader plugin appends one export line to `index.ts` as it loads; the file on
  disk is unchanged. After the split, these names must stay in scope in `index.ts`, defined or
  imported:
  - `handleRunGoal`
  - `handleResolve`
  - `executionStore`
  - `registerBuiltinResolvers`
  - `registerDevVesselProxies`
  - `registerDiscoveryProxies`

See the header of `child.ts` for details.
