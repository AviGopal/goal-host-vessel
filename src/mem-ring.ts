/**
 * Ring-buffer ordering utility.
 * Extracted from goal-host-vessel/src/index.ts flushMemDump.
 */

/**
 * Given a circular ring buffer, the current head index, and the declared
 * capacity, return the elements in insertion order (oldest → newest).
 *
 * - If the ring is not yet full (ring.length < size), the elements are already
 *   in order: return a shallow copy via slice().
 * - Otherwise the ring is full and head points at the OLDEST slot: return
 *   ring[head..end] concatenated with ring[0..head).
 */
export function orderRing<T>(ring: T[], head: number, size: number): T[] {
  if (ring.length < size) {
    return ring.slice();
  }
  return ring.slice(head).concat(ring.slice(0, head));
}
