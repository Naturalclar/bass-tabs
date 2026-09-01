/**
 * Turning a score into a note list for playback -- the proofing kind: one run
 * from the top so entered notes can be checked by ear before they are printed.
 * Follow-along features (cursor, looping, tempo following) stay out of scope.
 *
 * The notes come from the `Score` model directly, never from the MusicXML or
 * the rendered page -- so the written octave shift in musicxml.ts does not
 * apply here. tuning.ts speaks sounding pitch, and sounding pitch is what
 * should reach the speaker.
 *
 * Everything in this file is pure so the timing can be tested without an
 * AudioContext; usePlayback.ts is the thin layer that feeds it to Web Audio.
 */

import { DIVISIONS, clampTempo, measureCapacity, ticks, type Score } from './model.ts'
import { TUNINGS, midiFor } from './tuning.ts'

/** One note to sound. Times are in ticks: DIVISIONS per quarter note. */
export type PlaybackNote = { midi: number; startTicks: number; durationTicks: number }

/**
 * Tempo lives on the `Score` (see model.ts): it is printed on the page and
 * written to the file, so playback reads `score.tempo` rather than keeping a
 * knob of its own.
 */
export function secondsPerTick(tempo: number): number {
  return 60 / (clampTempo(tempo) * DIVISIONS)
}

/**
 * When each note sounds. Measures start on their barline: a half-written bar
 * is followed by silence up to where the next bar begins, which is what the
 * printed page implies -- so a note's start is its bar's start plus everything
 * before it in that bar. Rests take their time and produce no note.
 */
/**
 * Where a tick falls in the score: the entry sounding (or resting) at that
 * moment, or null in the silent tail of a half-written bar. This is what the
 * grid highlights during playback -- the inverse of `ticksAt`.
 */
export function columnAt(
  score: Score,
  tick: number,
): { measure: number; index: number } | null {
  const capacity = measureCapacity(score.time)
  const measure = Math.floor(tick / capacity)
  const entries = score.measures[measure]
  if (!entries) return null
  let at = measure * capacity
  for (let index = 0; index < entries.length; index++) {
    const duration = ticks(entries[index])
    if (tick < at + duration) return { measure, index }
    at += duration
  }
  return null
}

/** The tick a column starts on -- where "play from here" begins. */
export function ticksAt(score: Score, at: { measure: number; index: number }): number {
  const capacity = measureCapacity(score.time)
  let tick = at.measure * capacity
  const entries = score.measures[at.measure] ?? []
  for (let index = 0; index < Math.min(at.index, entries.length); index++) {
    tick += ticks(entries[index])
  }
  return tick
}

export function schedule(score: Score): PlaybackNote[] {
  const capacity = measureCapacity(score.time)
  const tuning = TUNINGS[score.tuning]
  const notes: PlaybackNote[] = []
  score.measures.forEach((entries, measure) => {
    let at = measure * capacity
    for (const entry of entries) {
      const duration = ticks(entry)
      if (entry.kind === 'note') {
        // A chord is its fingerings sounding together: one PlaybackNote per
        // string, all sharing the beat's start and length.
        for (const fingering of entry.notes) {
          notes.push({
            midi: midiFor(tuning, fingering.string, fingering.fret),
            startTicks: at,
            durationTicks: duration,
          })
        }
      }
      at += duration
    }
  })
  return notes
}
