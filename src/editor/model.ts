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
 * duration we support -- down to a dotted 16th (9) -- a whole number.
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

export type Note = {
  kind: 'note'
  /**
   * The strings sounding on this beat -- one for a single note, several for a
   * chord. Never empty, never the same string twice, kept sorted by string
   * number so two ways of entering the same chord are the same value.
   */
  notes: Fingering[]
  value: NoteValue
  dotted: boolean
}

export type Rest = {
  kind: 'rest'
  value: NoteValue
  dotted: boolean
}

export type Entry = Note | Rest

export type TimeSignature = { beats: number; beatType: number }

export type Score = {
  title: string
  /** Circle-of-fifths count, as in MusicXML: negative is flats. */
  keyFifths: number
  time: TimeSignature
  measures: Entry[][]
}

export function ticks(value: NoteValue, dotted: boolean): number {
  const base = WHOLE / value
  return dotted ? base * 1.5 : base
}

export function measureCapacity(time: TimeSignature): number {
  return (WHOLE / time.beatType) * time.beats
}

export function measureFilled(entries: Entry[]): number {
  return entries.reduce((sum, entry) => sum + ticks(entry.value, entry.dotted), 0)
}

export function measureRemaining(entries: Entry[], time: TimeSignature): number {
  return measureCapacity(time) - measureFilled(entries)
}

/** Whether one more entry of this length still fits in the measure. */
export function fits(entries: Entry[], time: TimeSignature, value: NoteValue, dotted: boolean) {
  return ticks(value, dotted) <= measureRemaining(entries, time)
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
    measures: [[], [], [], []],
  }
}
