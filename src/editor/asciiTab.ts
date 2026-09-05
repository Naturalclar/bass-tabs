/**
 * Reads an ASCII tab -- the plain-text notation most bass tabs online are
 * written in -- into the editor's model.
 *
 *     G|-----------------|-----------------|
 *     D|-----------0-----|-----------------|
 *     A|-----0--2-----2--|--0--2--3--2--0--|
 *     E|--0--------------|-----------------|
 *
 * The format carries strings, frets, and barlines, and nothing else: no note
 * values, no meter. So this reader follows the policy every other guessing
 * import here settled on (image, video, audio): **note values are not
 * inferred**. Every note in a bar gets one uniform value -- eighths, or
 * 16ths when a bar holds more than eight notes -- and the bar is padded to
 * the barline with rests, so bar N of the paste is bar N of the score and
 * the editor is where the rhythm gets fixed. Spacing between digits is a
 * writer's habit, not a rule, and reading it as rhythm would produce the
 * "plausible-looking wrong score" this codebase refuses to produce.
 *
 * What the model cannot hold is refused with a reason rather than dropped:
 * technique marks (h, p, /, \, ~, x, b ...) are part of how the tab is meant
 * to be played, and a score silently missing them would look complete. Same
 * contract as `musicxmlImport.ts` and `midiImport.ts`.
 *
 * Pure (text in, `Score` out) so it can be checked without a browser.
 */

import {
  MAX_MEASURES,
  NOTE_VALUES,
  emptyScore,
  measureCapacity,
  sortedFingerings,
  ticks,
  type Entry,
  type Fingering,
  type NoteValue,
  type Score,
} from './model.ts'
import { MAX_FRET, TUNINGS, type TuningName } from './tuning.ts'

export type AsciiTabImport =
  | {
      ok: true
      score: Score
      /** Whether any bar needed 16ths -- worth telling, since 8ths is the norm. */
      dense: boolean
    }
  | {
      ok: false
      reason: 'no-tab' | 'unsupported' | 'misaligned' | 'too-dense' | 'too-long' | 'no-notes'
    }

/** Uniform values tried per bar, coarsest first. */
const BAR_VALUES: NoteValue[] = [8, 16]

/** A tab line: an optional string label, then bars of characters. */
type Line = { label: string | null; bars: string[] }

/** One string line of one block, split at its barlines. */
function parseLine(raw: string): Line | null {
  // Label: a note letter (with optional sharp/flat) at the very start, before
  // the first barline or dash. "G|", "D |", "e|" -- case-insensitive, since
  // guitar tabs write the high strings lowercase.
  const match = /^\s*([A-Ga-g][#b]?)?\s*([|:]?)(.*)$/.exec(raw)
  if (!match) return null
  const [, label, , rest] = match
  // A tab line is mostly dashes. Anything else -- prose, lyrics, a chord
  // name row -- has no dashes to speak of.
  const dashes = (rest.match(/-/g) ?? []).length
  if (dashes < 4 || dashes < rest.replace(/[|\s]/g, '').length / 2) return null
  // Trailing barline and whitespace do not open another bar.
  const bars = rest
    .replace(/\s+$/, '')
    .split('|')
    .filter((bar) => bar.length > 0)
  return { label: label ? label.toUpperCase() : null, bars }
}

/**
 * Blocks: runs of consecutive tab lines. A tab of any length is several
 * blocks stacked down the page, each a slice of the same four (or five)
 * strings, read left to right and then on to the next block.
 */
function blocksOf(text: string): Line[][] {
  const blocks: Line[][] = []
  let current: Line[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = parseLine(raw)
    if (line) current.push(line)
    else if (current.length > 0) {
      blocks.push(current)
      current = []
    }
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

/**
 * Which tuning a block's labels spell, top line first. Unlabelled lines are
 * taken as standard for their count; labels that disagree (drop D, a
 * six-string) are a tuning the model does not have.
 */
function tuningOf(lines: Line[]): TuningName | null {
  for (const [name, tuning] of Object.entries(TUNINGS) as [TuningName, (typeof TUNINGS)['four']][]) {
    if (tuning.length !== lines.length) continue
    const matches = lines.every(
      (line, index) => line.label === null || line.label === tuning[index].step,
    )
    if (matches) return name
  }
  return null
}

/** A fret number read off one line: which columns it spans. */
type Digit = { string: number; fret: number; from: number; to: number }

/** Marks that mean something the model cannot hold. Anything not a digit or a dash. */
const TECHNIQUE = /[^0-9\-\s]/

function digitsOf(bar: string, string: number): Digit[] | 'unsupported' {
  if (TECHNIQUE.test(bar)) return 'unsupported'
  const digits: Digit[] = []
  for (const match of bar.matchAll(/\d+/g)) {
    const fret = Number(match[0])
    // "25" is not a fret; nor is it two notes -- the writer would have put
    // a dash between them. Refuse rather than read it either way.
    if (fret > MAX_FRET) return 'unsupported'
    digits.push({ string, fret, from: match.index, to: match.index + match[0].length })
  }
  return digits
}

/** Greedy plain rests for the tail of a bar. Bar widths here are multiples of six. */
function restsFor(remaining: number): Entry[] {
  const rests: Entry[] = []
  for (const value of NOTE_VALUES) {
    const rest: Entry = { kind: 'rest', value, dotted: false, triplet: false }
    while (remaining >= ticks(rest)) {
      rests.push(rest)
      remaining -= ticks(rest)
    }
  }
  return rests
}

/**
 * One bar of the block: notes in column order, chords where digits on
 * different strings share a column. "Share" is by overlap of the digit's
 * span, so a right-aligned "9" under a "10" still joins its chord.
 */
function barEntries(
  bar: Digit[],
  capacity: number,
): { entries: Entry[]; value: NoteValue } | 'too-dense' {
  const sorted = [...bar].sort((a, b) => a.from - b.from || a.string - b.string)
  const beats: Fingering[][] = []
  let end = -1
  for (const digit of sorted) {
    if (digit.from < end && beats.length > 0) {
      beats[beats.length - 1].push({ string: digit.string, fret: digit.fret })
      end = Math.max(end, digit.to)
    } else {
      beats.push([{ string: digit.string, fret: digit.fret }])
      end = digit.to
    }
  }
  for (const value of BAR_VALUES) {
    const duration = { value, dotted: false, triplet: false }
    const used = beats.length * ticks(duration)
    if (used > capacity) continue
    const entries: Entry[] = beats.map((notes) => ({
      kind: 'note',
      notes: sortedFingerings(notes),
      ...duration,
    }))
    return { entries: [...entries, ...restsFor(capacity - used)], value }
  }
  return 'too-dense'
}

/**
 * Whether the text has tab lines in it at all -- the cheap test the paste
 * handler runs so that pasting prose into the editor does nothing, while
 * a tab that is present but unreadable still gets its reason shown.
 */
export function isAsciiTab(text: string): boolean {
  return blocksOf(text).length > 0
}

export function fromAsciiTab(text: string, title: string): AsciiTabImport {
  const blocks = blocksOf(text)
  if (blocks.length === 0) return { ok: false, reason: 'no-tab' }

  const base = emptyScore()
  const capacity = measureCapacity(base.time)
  let tuning: TuningName | null = null
  const measures: Entry[][] = []
  let dense = false

  for (const block of blocks) {
    const blockTuning = tuningOf(block)
    if (blockTuning === null || (tuning !== null && blockTuning !== tuning)) {
      return { ok: false, reason: 'unsupported' }
    }
    tuning = blockTuning
    // Every line of a block must have the same bars, or the columns do not
    // line up and a chord cannot be told from two notes.
    const count = block[0].bars.length
    if (block.some((line) => line.bars.length !== count)) {
      return { ok: false, reason: 'misaligned' }
    }
    for (let index = 0; index < count; index++) {
      const digits: Digit[] = []
      for (const [lineIndex, line] of block.entries()) {
        // Lines run top to bottom, highest string first -- the same order
        // as `<string>` numbering, so the line index is the string number.
        const read = digitsOf(line.bars[index], lineIndex + 1)
        if (read === 'unsupported') return { ok: false, reason: 'unsupported' }
        digits.push(...read)
      }
      const bar = barEntries(digits, capacity)
      if (bar === 'too-dense') return { ok: false, reason: 'too-dense' }
      if (bar.value !== 8 && digits.length > 0) dense = true
      measures.push(bar.entries)
      if (measures.length > MAX_MEASURES) return { ok: false, reason: 'too-long' }
    }
  }

  if (!measures.some((entries) => entries.some((entry) => entry.kind === 'note'))) {
    return { ok: false, reason: 'no-notes' }
  }
  return {
    ok: true,
    dense,
    score: { ...base, title, tuning: tuning ?? base.tuning, measures },
  }
}
