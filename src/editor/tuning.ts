/**
 * The strings of a bass, and the conversions between a fretted position and a
 * written pitch.
 *
 * Two numbering schemes meet here and they run in opposite directions, which is
 * the easiest thing to get wrong in this file:
 *
 * - MusicXML `<string>` counts from the highest-pitched string, so G is 1.
 * - MusicXML `<staff-tuning line>` counts from the bottom staff line, so the
 *   lowest string is line 1.
 *
 * A `Tuning` is ordered high to low, matching the `<string>` numbering, so its
 * index + 1 is the string number and `tuning.length - index` is the line.
 *
 * The tuning is a property of the score, not of the app (`Score.tuning`): a
 * library can then hold four- and five-string scores at once, and an imported
 * file keeps the tuning it declares instead of being reinterpreted by a global
 * setting. Every function here therefore takes the tuning it works in --
 * nothing about strings is a module constant any more. That is what makes the
 * five-string case work, and what leaves the door open for drop tunings
 * without further design.
 */

export type OpenString = {
  /** MusicXML string number: 1 is the highest-pitched string. */
  number: number
  step: string
  octave: number
  /** MIDI note number of the open string. */
  midi: number
  label: string
}

/** Highest string first, so index 0 is `<string>1</string>`. */
export type Tuning = OpenString[]

/**
 * The tunings the app offers. Both keep the numbering of the four strings
 * they share -- `<string>` counts from the top, so G stays 1 and E stays 4
 * whether or not a low B hangs below them. That is why a four-string tab read
 * from an image still lands on the right strings of a five-string score.
 */
export const FOUR_STRING: Tuning = [
  { number: 1, step: 'G', octave: 2, midi: 43, label: 'G' },
  { number: 2, step: 'D', octave: 2, midi: 38, label: 'D' },
  { number: 3, step: 'A', octave: 1, midi: 33, label: 'A' },
  { number: 4, step: 'E', octave: 1, midi: 28, label: 'E' },
]

export const FIVE_STRING: Tuning = [
  ...FOUR_STRING,
  { number: 5, step: 'B', octave: 0, midi: 23, label: 'B' },
]

export type TuningName = 'four' | 'five'

export const TUNINGS: Record<TuningName, Tuning> = {
  four: FOUR_STRING,
  five: FIVE_STRING,
}

export const TUNING_LABELS: Record<TuningName, string> = {
  four: '4 弦 (E-A-D-G)',
  five: '5 弦 (B-E-A-D-G)',
}

/** The most strings any offered tuning has -- the grid's lane budget. */
export const MAX_STRINGS = Math.max(...Object.values(TUNINGS).map((tuning) => tuning.length))

export const MAX_FRET = 24

export function stringByNumber(tuning: Tuning, number: number): OpenString {
  const found = tuning.find((s) => s.number === number)
  if (!found) throw new Error(`no such string: ${number}`)
  return found
}

/** Staff line for a string number, counting from the bottom line up. */
export function staffLine(tuning: Tuning, stringNumber: number): number {
  return tuning.length - stringNumber + 1
}

export function midiFor(tuning: Tuning, stringNumber: number, fret: number): number {
  return stringByNumber(tuning, stringNumber).midi + fret
}

const SHARP_SPELLING = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
] as const

const FLAT_SPELLING = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0],
  ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
] as const

export type Pitch = { step: string; alter: number; octave: number }

/**
 * Written pitch for a MIDI note. Accidentals follow the key: a flat key spells
 * the black notes as flats, everything else as sharps. Without this, a piece in
 * F would print A# where the reader expects B flat.
 */
export function pitchFor(midi: number, keyFifths: number): Pitch {
  const table = keyFifths < 0 ? FLAT_SPELLING : SHARP_SPELLING
  const [step, alter] = table[((midi % 12) + 12) % 12]
  // MIDI 60 is C4, so octave numbering runs one below MIDI's own. Neither
  // spelling table crosses a letter over an octave boundary (there is no C-flat
  // or B-sharp in them), so the octave never needs adjusting for the letter.
  return { step, alter, octave: Math.floor(midi / 12) - 1 }
}

/**
 * Where to play a MIDI note: the highest string that still reaches down to it,
 * which is the one that needs the lowest fret. STRINGS runs high to low, so
 * taking the first playable one walks the frets upward from zero.
 */
export function positionFor(tuning: Tuning, midi: number): { string: number; fret: number } | null {
  for (const string of tuning) {
    const fret = midi - string.midi
    if (fret >= 0 && fret <= MAX_FRET) return { string: string.number, fret }
  }
  return null
}

/** A fretted position, independent of which entry holds it. */
export type Position = { string: number; fret: number }

/**
 * Moves a position by semitones, staying on the same string while it can.
 *
 * Staying put matters: a note sitting comfortably in the middle of a string
 * should not hop lanes just because the pitch moved by one. Only when the fret
 * would leave the neck does the same pitch get re-fingered somewhere else --
 * which is what makes "one semitone down" work at all on an open string.
 *
 * Returns null when the bass cannot play the resulting pitch anywhere.
 */
export function transpose(tuning: Tuning, position: Position, semitones: number): Position | null {
  const fret = position.fret + semitones
  if (fret >= 0 && fret <= MAX_FRET) return { string: position.string, fret }
  return positionFor(tuning, midiFor(tuning, position.string, position.fret) + semitones)
}

/**
 * The same pitch played on a neighbouring string: a fingering change, not a
 * pitch change. `delta` is -1 for the next string up in pitch, matching the
 * arrow that moves that way -- `<string>` numbers run the other direction.
 *
 * Returns null at the outer strings, or when the pitch does not reach the new
 * string's range.
 */
export function restring(tuning: Tuning, position: Position, delta: number): Position | null {
  const target = position.string + delta
  if (!tuning.some((string) => string.number === target)) return null
  const fret =
    midiFor(tuning, position.string, position.fret) - stringByNumber(tuning, target).midi
  if (fret < 0 || fret > MAX_FRET) return null
  return { string: target, fret }
}
