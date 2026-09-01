/**
 * The editable score. OSMD can only render, so this is our own model and
 * `toMusicXml()` is what bridges it back to the rest of the app: the generated
 * string goes through the exact same load/render/print path as an imported
 * file, so the A4 layout and the print checks apply to it unchanged.
 */

/** Note values, named by their denominator: 4 is a quarter note. */
export const NOTE_VALUES = [1, 2, 4, 8, 16] as const
export type NoteValue = (typeof NOTE_VALUES)[number]

/**
 * Divisions per quarter note. 24 is the smallest value that keeps every
 * duration we support a whole number: a dotted 16th is 9, and every triplet
 * lands on an integer too (an eighth triplet is 8, a 16th triplet 4), so
 * tuplets needed no change to the grid everything else is measured on.
 */
export const DIVISIONS = 24

/** How many measures a score may hold. */
export const MAX_MEASURES = 64

/** A whole note, in divisions. */
const WHOLE = DIVISIONS * 4

/** One fingered position: which string, which fret. */
export type Fingering = {
  /** MusicXML string number: 1 is the highest-pitched string, not the lowest. */
  string: number
  fret: number
}

/**
 * How long an entry lasts, before anything about pitch. `triplet` shortens it
 * to two thirds -- three in the space of two -- and is exclusive with
 * `dotted`: a dotted triplet is not a thing anyone writes here.
 *
 * The grouping is deliberately not in the model. A tuplet is three notes in
 * one bracket, but keeping `Entry[]` flat is what lets every function that
 * walks it -- edit.ts, playback.ts, the grid, measureRemaining -- stay
 * unchanged. `musicxml.ts` derives the brackets from runs of three when it
 * writes, which is the same division of labour as `padded()`: the model
 * holds what was entered, the serialiser makes it well-formed notation.
 */
export type Duration = {
  value: NoteValue
  dotted: boolean
  triplet: boolean
}

export type Note = Duration & {
  kind: 'note'
  /**
   * The strings sounding on this beat -- one for a single note, several for a
   * chord. Never empty, never the same string twice, kept sorted by string
   * number so two ways of entering the same chord are the same value.
   */
  notes: Fingering[]
}

export type Rest = Duration & {
  kind: 'rest'
}

export type Entry = Note | Rest

export type TimeSignature = { beats: number; beatType: number }

export type Score = {
  title: string
  /** Circle-of-fifths count, as in MusicXML: negative is flats. */
  keyFifths: number
  time: TimeSignature
  /**
   * Quarter notes per minute whatever the meter -- the one BPM meaning that
   * needs no per-meter rules. Part of the score, not a playback knob: it is
   * printed on the page (♩=N) and written to the exported file.
   */
  tempo: number
  measures: Entry[][]
}

export const MIN_TEMPO = 30
export const MAX_TEMPO = 300

export function clampTempo(tempo: number): number {
  return Math.min(Math.max(tempo, MIN_TEMPO), MAX_TEMPO)
}

/**
 * Takes the whole duration rather than its fields: the next attribute to
 * appear (a quintuplet, say) then reaches every caller for free instead of
 * touching the nine call sites `triplet` would otherwise have needed.
 */
export function ticks({ value, dotted, triplet }: Duration): number {
  const base = WHOLE / value
  if (triplet) return (base * 2) / 3
  return dotted ? base * 1.5 : base
}

export function measureCapacity(time: TimeSignature): number {
  return (WHOLE / time.beatType) * time.beats
}

export function measureFilled(entries: Entry[]): number {
  return entries.reduce((sum, entry) => sum + ticks(entry), 0)
}

export function measureRemaining(entries: Entry[], time: TimeSignature): number {
  return measureCapacity(time) - measureFilled(entries)
}

/** Whether one more entry of this length still fits in the measure. */
export function fits(entries: Entry[], time: TimeSignature, duration: Duration) {
  return ticks(duration) <= measureRemaining(entries, time)
}

/** Fingerings in canonical order: string 1 (G) first. */
export function sortedFingerings(notes: Fingering[]): Fingering[] {
  return [...notes].sort((a, b) => a.string - b.string)
}

export function emptyScore(): Score {
  return {
    title: '無題',
    keyFifths: 0,
    time: { beats: 4, beatType: 4 },
    tempo: 160,
    measures: [[], [], [], []],
  }
}
