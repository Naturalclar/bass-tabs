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

/** One token per beat: strings used + coarse position along the staff. */
export function signatureOf(analysis: {
  columns: { parts: { string: number; x0: number; x1: number }[] }[]
  tabX0: number
  tabX1: number
}): ScreenSignature {
  const span = Math.max(1, analysis.tabX1 - analysis.tabX0)
  return analysis.columns.map((column) => {
    const strings = column.parts.map((part) => part.string).join('+')
    const centre =
      column.parts.reduce((sum, part) => sum + (part.x0 + part.x1) / 2, 0) /
      column.parts.length
    // 40 buckets across the staff: fine enough to separate beats, coarse
    // enough that a pixel of jitter between frames lands in the same bucket.
    const bucket = Math.round(((centre - analysis.tabX0) / span) * 40)
    return `${strings}@${bucket}`
  })
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
