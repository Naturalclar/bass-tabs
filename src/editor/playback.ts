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

import { DIVISIONS, measureCapacity, ticks, type Score } from './model.ts'
import { midiFor } from './tuning.ts'

/** One note to sound. Times are in ticks: DIVISIONS per quarter note. */
export type PlaybackNote = { midi: number; startTicks: number; durationTicks: number }

/**
 * Tempo is quarter notes per minute whatever the meter -- the one BPM meaning
 * that needs no per-meter rules. It is a playback-only setting: `Score` has no
 * tempo field, and deliberately does not gain one here (that would change the
 * stored shape and the exported file for a knob only the speaker uses).
 */
export const MIN_BPM = 30
export const MAX_BPM = 300
export const DEFAULT_BPM = 100

export function clampBpm(bpm: number): number {
  return Math.min(Math.max(bpm, MIN_BPM), MAX_BPM)
}

export function secondsPerTick(bpm: number): number {
  return 60 / (clampBpm(bpm) * DIVISIONS)
}

/**
 * When each note sounds. Measures start on their barline: a half-written bar
 * is followed by silence up to where the next bar begins, which is what the
 * printed page implies -- so a note's start is its bar's start plus everything
 * before it in that bar. Rests take their time and produce no note.
 */
export function schedule(score: Score): PlaybackNote[] {
  const capacity = measureCapacity(score.time)
  const notes: PlaybackNote[] = []
  score.measures.forEach((entries, measure) => {
    let at = measure * capacity
    for (const entry of entries) {
      const duration = ticks(entry.value, entry.dotted)
      if (entry.kind === 'note') {
        // A chord is several fingerings on one beat: same start, same length,
        // one PlaybackNote each, so they sound together.
        for (const fingering of entry.notes) {
          notes.push({
            midi: midiFor(fingering.string, fingering.fret),
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
