// A WALK'S CONFIRMED WRITE READ-BACK IS A STEP OF THE WALK, AND A WALK THAT HAS ONE IS NOT "HOLLOW".
//
// The walk reads a terminal write back before it credits it (index.ts verifyWritePersistedRead: a shaped read of the
// same store by rawResolve, confirmed when the answer holds the written id). That read used to stay inside the
// satisfier: the pool held only the write, so the reach pre-gate's read-back rule (reach-grounding.ts changeEvidence,
// rule 7) saw a write with no later read and refused it "unconfirmed"; and satisfier productions write no
// "step N ran" line, so one failed template step beside the verified write made the hollow-walklog cap read "every
// logged step produced 0 new shapes" and skip the judge. Measured on a note goal whose write landed in the store and
// was graded HOLLOW and beta-penalised.
//
// Here: the confirmed read-back is recorded as its own pool step right after the write (only from the confirming
// rawResolve's real result: shape, confirmed id and the record it returned; never inferred), and the hollow cap does not
// apply to a walk holding a read-back-confirmed terminal write. Neither the cap nor rule 7 is loosened for any other walk.

/** A read-back the walk actually performed that confirmed a write: the read shape, the id it found, the read's result. */
export interface ConfirmedReadBack { readShape: string; confirmedId: string; content: unknown }

/** The pool step to record right after `writeShape` enters the pool: its confirmed read-back, or null when there is none
 *  (no confirming read was made, or the read shape is already in the pool). Never synthesised. */
export function readBackStepFor(
  writeShape: string,
  confirmed: ReadonlyMap<string, ConfirmedReadBack>,
  produced: ReadonlySet<string>,
): { shape: string; content: unknown; summary: string } | null {
  const rb = confirmed.get(writeShape);
  if (!rb || !rb.readShape || !rb.confirmedId || produced.has(rb.readShape)) return null;
  return { shape: rb.readShape, content: rb.content, summary: `write read-back of ${writeShape} (${rb.readShape}, confirmed id ${rb.confirmedId})` };
}

/** The walk's terminal writes that a satisfier verified AND read back with a confirming read (`satisfier:<shape>` keys of
 *  the walk's verifiedWrites that also have a ConfirmedReadBack). */
export function confirmedTerminalWritesOf(
  verifiedWrites: Iterable<string>,
  confirmed: ReadonlyMap<string, ConfirmedReadBack>,
  isTerminal: (shape: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const k of verifiedWrites) {
    if (!k.startsWith("satisfier:")) continue;
    const sh = k.slice("satisfier:".length);
    if (confirmed.has(sh) && isTerminal(sh) && !out.includes(sh)) out.push(sh);
  }
  return out;
}

/** Does the hollow-walklog cap apply? Not to a walk holding a read-back-confirmed terminal write. */
export function hollowCapApplies(walkEvidence: { confirmedTerminalWrites?: readonly string[] } | null | undefined): boolean {
  return !!walkEvidence && !((walkEvidence.confirmedTerminalWrites?.length ?? 0) > 0);
}
