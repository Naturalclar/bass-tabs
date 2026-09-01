import {
  MAX_MEASURES,
  MAX_TEMPO,
  MIN_TEMPO,
  NOTE_VALUES,
  emptyScore,
  measureRemaining,
  sortedFingerings,
  type Entry,
  type NoteValue,
  type Score,
} from './model.ts'
import { MAX_FRET, TUNINGS, type Tuning, type TuningName } from './tuning.ts'

/**
 * Reads a tab-bearing MusicXML file back into the editor's model.
 *
 * This is deliberately narrow. It reads what `musicxml.ts` writes -- the tab
 * staff, where each note carries `<technical><string><fret>` -- and nothing
 * else. Anything richer than this app can hold (chords, ties, tuplets, several
 * parts) has no representation to be read into, so a file without tab data is
 * refused rather than half-imported into something that looks like the
 * original but is not.
 *
 * Reading positions rather than pitches also sidesteps the written octave: the
 * frets say where the fingers go regardless of how the notes were spelled.
 */

const VALUE_BY_TYPE: Record<string, NoteValue> = {
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  '16th': 16,
}

const BEAT_TYPES = [1, 2, 4, 8, 16]

export type MusicXmlImport =
  | { ok: true; score: Score }
  | { ok: false; reason: 'unreadable' | 'no-tab' | 'unsupported' | 'too-long' | 'overfull' }

type Fingering = { string: number; fret: number }

function text(parent: ParentNode | null, selector: string): string | null {
  return parent?.querySelector(selector)?.textContent?.trim() ?? null
}

function integer(parent: ParentNode | null, selector: string): number | null {
  const value = Number(text(parent, selector))
  return Number.isInteger(value) ? value : null
}

/** The staff that carries fret numbers, which is the one this app can read. */
function tabStaffNumber(part: Element): string | null {
  for (const clef of part.querySelectorAll('clef')) {
    if (clef.querySelector('sign')?.textContent?.trim() === 'TAB') {
      return clef.getAttribute('number') ?? '1'
    }
  }
  return null
}

function fingeringOf(note: Element, tuning: TuningName): Fingering | null {
  const technical = note.querySelector('technical')
  const string = Number(text(technical, 'string'))
  const fret = Number(text(technical, 'fret'))
  if (!TUNINGS[tuning].some((entry) => entry.number === string)) return null
  if (!Number.isInteger(fret) || fret < 0 || fret > MAX_FRET) return null
  return { string, fret }
}

/**
 * Whether a note is a triplet -- three in the time of two. Anything else
 * under `<time-modification>` (a quintuplet, a duplet) has no representation
 * here, and is refused rather than read as its plain value: this file used to
 * ignore the element entirely, which silently turned triplet eighths into
 * straight eighths whenever the bar happened to have room for them.
 */
function tripletOf(note: Element): boolean | 'unsupported' {
  const modification = note.querySelector('time-modification')
  if (!modification) return false
  const actual = Number(text(modification, 'actual-notes'))
  const normal = Number(text(modification, 'normal-notes'))
  if (actual === 3 && normal === 2) return true
  return 'unsupported'
}

/**
 * Which offered tuning the file declares. `<staff-lines>` alone would be
 * enough to pick the lane count, but the open strings decide what the frets
 * mean, so both must match a tuning we can actually hold -- anything else
 * (a six-string, a drop tuning) is refused rather than read as if it were
 * standard, which would put every note at the wrong pitch.
 */
function tuningOf(part: Element): TuningName | null {
  const details = part.querySelector('staff-details')
  const declared = details?.querySelectorAll('staff-tuning') ?? []
  // Nothing declared: the file predates the question, and four strings is
  // what this app wrote before it could ask.
  if (declared.length === 0) return 'four'
  const steps = [...declared]
    .map((entry) => ({
      line: Number(entry.getAttribute('line')),
      step: text(entry, 'tuning-step'),
      octave: Number(text(entry, 'tuning-octave')),
    }))
    .sort((a, b) => a.line - b.line)
  for (const [name, candidate] of Object.entries(TUNINGS) as [TuningName, Tuning][]) {
    if (candidate.length !== steps.length) continue
    // `<staff-tuning line>` counts from the bottom, `<string>` from the top.
    const expected = [...candidate].sort((a, b) => b.number - a.number)
    const matches = expected.every(
      (open, index) =>
        open.step === steps[index]?.step && open.octave + 1 === steps[index]?.octave,
    )
    if (matches) return name
  }
  return null
}

function entryOf(note: Element, tuning: TuningName): Entry | 'unsupported' | null {
  const value = VALUE_BY_TYPE[text(note, 'type') ?? '']
  if (!value || !(NOTE_VALUES as readonly number[]).includes(value)) return null
  const dotted = note.querySelector('dot') !== null
  const triplet = tripletOf(note)
  if (triplet === 'unsupported') return 'unsupported'

  if (note.querySelector('rest')) return { kind: 'rest', value, dotted, triplet }

  const fingering = fingeringOf(note, tuning)
  return fingering === null ? null : { kind: 'note', notes: [fingering], value, dotted, triplet }
}

export function fromMusicXml(xml: string): MusicXmlImport {
  let document: Document
  try {
    document = new DOMParser().parseFromString(xml, 'application/xml')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (document.querySelector('parsererror')) return { ok: false, reason: 'unreadable' }

  const part = document.querySelector('part')
  if (!part) return { ok: false, reason: 'unreadable' }

  const staff = tabStaffNumber(part)
  if (!staff) return { ok: false, reason: 'no-tab' }

  // The file states its own instrument. Reading it rather than assuming four
  // strings is what lets a five-string score survive a round trip, and what
  // stops a five-string file from being read as a four-string one with an
  // out-of-range string number on every low note.
  const tuning = tuningOf(part)
  if (tuning === null) return { ok: false, reason: 'unsupported' }

  const base = emptyScore()
  const beats = integer(part, 'time beats')
  const beatType = integer(part, 'time beat-type')
  const fifths = integer(part, 'key fifths')

  const measures: Entry[][] = []
  for (const measure of part.querySelectorAll('measure')) {
    const entries: Entry[] = []
    for (const note of measure.querySelectorAll('note')) {
      // Every event is written on both staves; reading one keeps each once.
      if (text(note, 'staff') !== staff) continue
      // Ties (either spelling) and grace notes have no representation in the
      // model. Dropping the markup and keeping the notes would import each
      // tied pair as two attacks -- a score that looks like the original but
      // is not -- so the file is refused, which is what the contract at the
      // top of this file promises.
      if (note.querySelector('tie, tied, grace')) return { ok: false, reason: 'unsupported' }
      // A <chord/> note shares the previous note's beat: it joins that entry
      // instead of becoming its own. Two chord tones on the same string is a
      // file the model cannot spell, so it is refused, not half-kept.
      if (note.querySelector('chord')) {
        const previous = entries[entries.length - 1]
        const fingering = fingeringOf(note, tuning)
        if (tripletOf(note) === 'unsupported') return { ok: false, reason: 'unsupported' }
        if (!previous || previous.kind !== 'note' || fingering === null) {
          return { ok: false, reason: 'unsupported' }
        }
        if (previous.notes.some((existing) => existing.string === fingering.string)) {
          return { ok: false, reason: 'unsupported' }
        }
        previous.notes = sortedFingerings([...previous.notes, fingering])
        continue
      }
      const entry = entryOf(note, tuning)
      if (entry === 'unsupported') return { ok: false, reason: 'unsupported' }
      if (entry) entries.push(entry)
    }
    measures.push(entries)
  }
  if (measures.length === 0) return { ok: false, reason: 'unreadable' }
  // The same limits the storage validator enforces on reload. Anything let
  // through here would save, show "imported", and then vanish on the next
  // visit when `isScore` refuses to read it back.
  if (measures.length > MAX_MEASURES) return { ok: false, reason: 'too-long' }

  const time = {
    beats: beats && beats >= 1 && beats <= 32 ? beats : base.time.beats,
    beatType: beatType && BEAT_TYPES.includes(beatType) ? beatType : base.time.beatType,
  }
  // A bar holding more than the time signature allows is a state the editor
  // itself refuses to create, so nothing downstream is prepared for it.
  if (measures.some((entries) => measureRemaining(entries, time) < 0)) {
    return { ok: false, reason: 'overfull' }
  }

  // <sound tempo> is quarter notes per minute -- the same meaning as
  // score.tempo. A missing or out-of-range value falls back to the default
  // rather than failing the file: tempo is presentation, not substance.
  const sound = Number(part.querySelector('sound')?.getAttribute('tempo'))
  const metronome = Number(text(part, 'metronome per-minute'))
  const tempoOf = (value: number) =>
    Number.isInteger(value) && value >= MIN_TEMPO && value <= MAX_TEMPO ? value : null
  const tempo = tempoOf(sound) ?? tempoOf(metronome) ?? base.tempo

  return {
    ok: true,
    score: {
      title: text(document, 'work-title') ?? base.title,
      keyFifths: fifths ?? base.keyFifths,
      time,
      tempo,
      tuning,
      measures,
    },
  }
}
