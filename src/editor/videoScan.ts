/**
 * Telling one screenful of tab from the next while scanning a video file.
 *
 * A play-through video shows a line of tab for a while, then switches. The
 * scan wants to OCR each line exactly once, but consecutive frames of the
 * same line are not pixel-identical -- the playhead moves, and sometimes sits
 * on top of a digit. So a screen is described by where its beats sit
 * (horizontal position, scaled by the staff's own width) and which strings
 * they use, and two descriptions are "the same screen" when most beats agree
 * rather than all of them.
 */

export type ScreenSignature = string[]

/** How many position buckets span the staff, left edge to right edge. */
export const BUCKETS = 40

/** One beat as the scan sees it before OCR: which strings, where. */
export type ScreenBeat = { strings: string; bucket: number }

/**
 * The beats of a frame, left to right. Position is in buckets across the
 * staff: fine enough to separate beats, coarse enough that a pixel of
 * jitter between frames lands in the same bucket.
 */
export function beatsOf(analysis: {
  columns: { parts: { string: number; x0: number; x1: number }[] }[]
  tabX0: number
  tabX1: number
}): ScreenBeat[] {
  const span = Math.max(1, analysis.tabX1 - analysis.tabX0)
  return analysis.columns.map((column) => {
    const strings = column.parts.map((part) => part.string).join('+')
    const centre =
      column.parts.reduce((sum, part) => sum + (part.x0 + part.x1) / 2, 0) /
      column.parts.length
    return { strings, bucket: Math.round(((centre - analysis.tabX0) / span) * BUCKETS) }
  })
}

/** One token per beat: strings used + coarse position along the staff. */
export function signatureOf(analysis: Parameters<typeof beatsOf>[0]): ScreenSignature {
  return beatsOf(analysis).map((beat) => `${beat.strings}@${beat.bucket}`)
}

/**
 * Same screen? Most beats must match. The threshold leaves room for the
 * playhead to occlude a beat or two without the frame reading as a new
 * screen, while a genuinely new line of tab shares almost nothing.
 */
export function sameScreen(a: ScreenSignature, b: ScreenSignature): boolean {
  if (a.length === 0 || b.length === 0) return a.length === b.length
  const counts = new Map<string, number>()
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1)
  let shared = 0
  for (const token of b) {
    const left = counts.get(token) ?? 0
    if (left > 0) {
      shared++
      counts.set(token, left - 1)
    }
  }
  return shared / Math.max(a.length, b.length) >= 0.7
}

/**
 * A beat this close to the right edge may still be entering the frame, cut
 * in half; it is read once it has moved a little further in.
 */
const EDGE_BUCKETS = 2

/**
 * The other way a video shows tab: one long line that scrolls under a fixed
 * playhead, so no two frames are the same screen and `sameScreen` never
 * fires. Between two frames half a second apart the beats have all moved
 * left by the same amount, and that shared shift is what identifies them.
 *
 * Given the beats already appended (`previous`, in the coordinates of the
 * frame they were seen in) and the current frame's beats, finds the shift
 * that makes most of them line up, and returns which of the current beats
 * are new: past the last one that matched, and far enough from the right
 * edge to be whole. Null when no shift explains the frame -- a hard cut to
 * another screen, which the caller handles as a new page.
 *
 * Matching ignores frets on purpose: OCR is the expensive step and this runs
 * on every sampled frame. Strings-plus-position is enough to tell "the same
 * line, moved" from "a different line", and a repeated riff at a page
 * boundary is the one thing it cannot tell apart -- see README.
 */
export function scrolledBeats(
  previous: ScreenBeat[],
  current: ScreenBeat[],
): { shift: number; matched: boolean[]; fresh: number[] } | null {
  if (previous.length === 0 || current.length === 0) return null
  let best: { shift: number; matched: boolean[]; count: number; error: number } | null = null
  // Content moves left as it scrolls, so a previous beat sits at a larger
  // bucket than the same beat now: shift = previous - current >= 0. Zero is
  // included for tabs that stay put while notes appear along the line.
  for (let shift = 0; shift < BUCKETS; shift++) {
    const taken = new Set<number>()
    let error = 0
    const matched = current.map((beat) => {
      const index = previous.findIndex(
        (candidate, i) =>
          !taken.has(i) &&
          candidate.strings === beat.strings &&
          Math.abs(candidate.bucket - (beat.bucket + shift)) <= 1,
      )
      if (index === -1) return false
      taken.add(index)
      error += Math.abs(previous[index].bucket - (beat.bucket + shift))
      return true
    })
    const count = matched.filter(Boolean).length
    // The one-bucket tolerance lets neighbouring shifts match the same
    // beats; among equals, the shift that lands them most exactly wins.
    if (!best || count > best.count || (count === best.count && error < best.error)) {
      best = { shift, matched, count, error }
    }
  }
  // Most of what both frames can show must agree, and enough of it to mean
  // something: two beats lining up by chance is easy, five is not.
  const visible = Math.min(previous.length, current.length)
  if (!best || best.count < 3 || best.count / visible < 0.6) return null
  const lastMatched = best.matched.lastIndexOf(true)
  const fresh = current
    .map((_, index) => index)
    .filter((index) => index > lastMatched && !best.matched[index] && isWhole(current[index]))
  return { shift: best.shift, matched: best.matched, fresh }
}

/** A beat far enough from both edges of the frame to be all there. */
export function isWhole(beat: ScreenBeat): boolean {
  return beat.bucket >= EDGE_BUCKETS && beat.bucket <= BUCKETS - EDGE_BUCKETS
}
