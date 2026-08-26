import {
  MAX_MEASURES,
  NOTE_VALUES,
  emptyScore,
  measureRemaining,
  type Entry,
  type NoteValue,
  type Score,
} from './model.ts'
import { MAX_FRET, STRINGS } from './tuning.ts'

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

function entryOf(note: Element): Entry | null {
  const value = VALUE_BY_TYPE[text(note, 'type') ?? '']
  if (!value || !(NOTE_VALUES as readonly number[]).includes(value)) return null
  const dotted = note.querySelector('dot') !== null

  if (note.querySelector('rest')) return { kind: 'rest', value, dotted }

  const technical = note.querySelector('technical')
  const string = Number(text(technical, 'string'))
  const fret = Number(text(technical, 'fret'))
  if (!STRINGS.some((entry) => entry.number === string)) return null
  if (!Number.isInteger(fret) || fret < 0 || fret > MAX_FRET) return null
  return { kind: 'note', string, fret, value, dotted }
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
      // Chords, ties (either spelling) and grace notes have no representation
      // in the model.
      // Dropping the markup and keeping the notes would import each chord
      // tone as its own beat and each tied pair as two attacks -- a score
      // that looks like the original but is not -- so the file is refused,
      // which is what the contract at the top of this file promises.
      if (note.querySelector('chord, tie, tied, grace')) return { ok: false, reason: 'unsupported' }
      const entry = entryOf(note)
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

  return {
    ok: true,
    score: {
      title: text(document, 'work-title') ?? base.title,
      keyFifths: fifths ?? base.keyFifths,
      time,
      measures,
    },
  }
}
