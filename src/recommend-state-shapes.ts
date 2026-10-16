/**
 * C6 (restored): THE RECOVERY PICK IS STATE-CONDITIONED.
 *
 * 4912bb0 (06-26) passed the walk's available input-shape pool to activity-api's /recommend as `impulse_shapes`, so the
 * recommender derives the state-space signature and reads the SIGNATURE-CONDITIONED posterior (context_thompson_scores)
 * for the next recovery approach; Mechanism #7 passed the goal's direction as `completion_shapes` for the
 * successor-features look-ahead. af61dee (06-28, Substrate Autonomous, "unknown-proposal") removed both with no gap, so
 * the in-flight recovery pick had been state-blind since: per-state posteriors were written but not read where recovery
 * chooses. activity-api's /recommend still reads both fields.
 *
 * Empty means omitted: a walk with nothing pooled sends exactly the state-blind body it sent before.
 */
export function c6StateShapeFields(stateShapes?: { impulse?: readonly string[]; completion?: readonly string[] | null }): { impulse_shapes?: string[]; completion_shapes?: string[] } {
  return {
    ...(stateShapes?.impulse && stateShapes.impulse.length ? { impulse_shapes: [...stateShapes.impulse] } : {}),
    ...(stateShapes?.completion && stateShapes.completion.length ? { completion_shapes: [...stateShapes.completion] } : {}),
  };
}
