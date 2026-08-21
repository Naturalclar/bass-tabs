/**
 * Four-string bass in standard tuning, plus the conversions between a fretted
 * position and a written pitch.
 *
 * Two numbering schemes meet here and they run in opposite directions, which is
 * the easiest thing to get wrong in this file:
 *
 * - MusicXML `<string>` counts from the highest-pitched string, so G is 1.
 * - MusicXML `<staff-tuning line>` counts from the bottom staff line, so the
 *   lowest string E is line 1.
 *
 * `STRINGS` below is ordered high to low, matching the `<string>` numbering, so
 * its index + 1 is the string number and `STRINGS.length - index` is the line.
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
export const STRINGS: OpenString[] = [
  { number: 1, step: 'G', octave: 2, midi: 43, label: 'G' },
  { number: 2, step: 'D', octave: 2, midi: 38, label: 'D' },
  { number: 3, step: 'A', octave: 1, midi: 33, label: 'A' },
  { number: 4, step: 'E', octave: 1, midi: 28, label: 'E' },
]

export const MAX_FRET = 24

export function stringByNumber(number: number): OpenString {
  const found = STRINGS.find((s) => s.number === number)
  if (!found) throw new Error(`no such string: ${number}`)
  return found
}

/** Staff line for a string number, counting from the bottom line up. */
export function staffLine(stringNumber: number): number {
  return STRINGS.length - stringNumber + 1
}

export function midiFor(stringNumber: number, fret: number): number {
  return stringByNumber(stringNumber).midi + fret
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
export function positionFor(midi: number): { string: number; fret: number } | null {
  for (const string of STRINGS) {
    const fret = midi - string.midi
    if (fret >= 0 && fret <= MAX_FRET) return { string: string.number, fret }
  }
  return null
}
