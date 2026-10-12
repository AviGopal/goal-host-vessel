# Routing corpus (goal-host): closed, append-only

Pins the edit-intent route: which goals go to feature_compose, and onto which file. Every case replays through
`src/routing-core/entries.ts routeEditIntent` (the door's pathless resolution over recorded ports, the open
`decideDoor`, the gap-record hydration, the open `decideHandoff`), the same functions production calls.

- `MANIFEST.jsonl` chains `cases/<class>/<NNNN>-<slug>.json` (canonical bytes). Cases are appended by an operator act
  (`bun test/routing-corpus/cli.ts append <case.json>`), never edited or removed; the admission glue refuses anything
  but an append.
- `status_at_append`: `green` cases must stay green; `known_red` cases may stay red until the fix they define lands.
- `localization-record.schema.json`: the `localizationRecord` shape (a need's file and the evidence it is the site:
  `{gap_id|dispatch_id, file, evidence: [{read, why}], method, created_at}`), persisted on the gap record
  (`gap.localization`) and on the trace. The core passes a record to the rules only when it is valid.

## What the known-red class defines
`pathless-need-routed-to-file-edit`: a need that names no file is not routed to a file edit unless a valid
localizationRecord names the file the route would edit; until then the door declines the restatement and reports that
the need needs localization. Done is every case in the class green with every control still green. The open part is a
`decideDoor` tightening; the parts outside it (not built here) are a producer of the record (a localization step that
reads, cites and persists it) and the core passing the stored record to the door.

At the class's fix, the door clamp may also restate onto `localization.file` when a VALID record names a file other
than the resolver's choice; that change comes with its own case ("a record-named file routes there"). Until then a
record naming another file means no file edit (the case for it stays as written).
