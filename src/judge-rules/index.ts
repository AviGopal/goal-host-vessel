/**
 * The open judge rules: the one module the closed judge core (src/judge/entries.ts) imports, by a single
 * dynamic import of exactly these names. Every rule here is pure (no I/O, no clock, no randomness, no
 * environment), and its behaviour is pinned by the closed verdict corpus (test/verdict-corpus/).
 */
export { reachGate } from "./write-goal";
export { decide as floorDecide, shortcutAllowed as floorShortcutAllowed } from "./floor";
export { accept as reframeAccept } from "./reframe";
