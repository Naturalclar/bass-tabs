/**
 * Reads a standard MIDI file (SMF) into the editor's model -- the reverse of
 * `midiFile.ts`, and the harder direction. The file holds a performance:
 * note-ons and note-offs at absolute ticks, no bars, no note values. The
 * model holds notation. Translating one into the other means deciding what
 * each note *is*, and this reader refuses to guess.
 *
 * Deliberately narrow, the same contract as `musicxmlImport.ts`: a file
 * either lands on the model exactly or is refused with a reason, because a
 * file read approximately is a score that looks like the original and is
 * not. Concretely:
 *
 * - Every onset and every note end must land on the model's grid (24 ticks a
 *   quarter) once the file's own division is scaled. A DAW's 480-tick file
 *   passes when it was drawn on the grid; a played-in one does not. Rounding
 *   what misses is quantisation, which belongs to #75 and is not done here.
 * - A note's length must be a value the model has -- plain, dotted or triplet,
 *   whole to 16th. A 32nd, or a length no value spells, is refused.
 * - The model has no ties, so a note may not cross a barline; and it has one
 *   duration per beat, so notes may only overlap when they start together
 *   (a chord) and end together.
 * - One track carries the notes. A file with drums, keys and bass is not a
 *   bass part, and choosing for the person is worse than asking.
 *
 * Strings and frets are not in the file, so they are re-derived: the highest
 * note of each beat takes the highest string that reaches it (`positionFor`'s
 * rule), and the rest of a chord is placed below it so no string sounds
 * twice -- the constraint `storage.ts` enforces. A pitch no string reaches is
 * dropped and counted, as the image import counts what its OCR cannot read.
 *
 * Everything here is pure (`Uint8Array` in, `Score` out) so the round trip
 * through `toMidiFile()` can be checked in Node.
 */

import {
  DIVISIONS,
  MAX_MEASURES,
  NOTE_VALUES,
  clampTempo,
  emptyScore,
  measureCapacity,
  sortedFingerings,
  ticks,
  type Duration,
  type Entry,
  type Fingering,
  type Score,
  type TimeSignature,
} from './model.ts'
import { MAX_FRET, TUNINGS, type Tuning, type TuningName } from './tuning.ts'

export type MidiImport =
  | {
      ok: true
      score: Score
      /** Notes no string of the tuning reaches, left out of their beat. */
      dropped: number
    }
  | {
      ok: false
      reason:
        | 'unreadable'
        | 'smpte'
        | 'multi-track'
        | 'off-grid'
        | 'unsupported'
        | 'too-long'
        | 'no-notes'
    }

const META = 0xff
const META_TRACK_NAME = 0x03
const META_TEMPO = 0x51
const META_TIME_SIGNATURE = 0x58
const META_KEY_SIGNATURE = 0x59
const SYSEX = 0xf0
const SYSEX_CONTINUED = 0xf7
const NOTE_OFF = 0x80
const NOTE_ON = 0x90
const PROGRAM_CHANGE = 0xc0
const CHANNEL_PRESSURE = 0xd0

const BEAT_TYPES = [1, 2, 4, 8, 16]

/** A note as the file states it: pitch and a tick range, nothing else. */
type RawNote = { midi: number; start: number; end: number }

type Track = {
  name: string | null
  tempo: number | null
  time: TimeSignature | null
  keyFifths: number | null
  notes: RawNote[]
}

type Header = { division: number; tracks: Track[] }

/**
 * Walks the chunks. Anything malformed throws, and `fromMidi` turns that into
 * `unreadable`: there is no partial reading of a file whose framing is off.
 */
function parse(bytes: Uint8Array): Header {
  let at = 0
  const byte = () => {
    if (at >= bytes.length) throw new Error('truncated')
    return bytes[at++]
  }
  const uint = (length: number) => {
    let value = 0
    for (let i = 0; i < length; i++) value = value * 256 + byte()
    return value
  }
  const ascii = (length: number) => String.fromCharCode(...Array.from({ length }, byte))

  if (ascii(4) !== 'MThd') throw new Error('not a MIDI file')
  const headerLength = uint(4)
  if (headerLength < 6) throw new Error('bad header')
  uint(2) // format: 0 and 1 read the same way here, and 2 has no use for a score
  const trackCount = uint(2)
  const division = uint(2)
  at += headerLength - 6

  const tracks: Track[] = []
  while (at < bytes.length && tracks.length < trackCount) {
    const type = ascii(4)
    const length = uint(4)
    const end = at + length
    if (end > bytes.length) throw new Error('truncated track')
    if (type !== 'MTrk') {
      at = end
      continue
    }
    tracks.push(parseTrack(bytes.subarray(at, end)))
    at = end
  }
  return { division, tracks }
}

function parseTrack(bytes: Uint8Array): Track {
  const track: Track = { name: null, tempo: null, time: null, keyFifths: null, notes: [] }
  let at = 0
  const byte = () => {
    if (at >= bytes.length) throw new Error('truncated')
    return bytes[at++]
  }
  const variableLength = () => {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const b = byte()
      value = (value << 7) | (b & 0x7f)
      if ((b & 0x80) === 0) return value
    }
    throw new Error('bad delta')
  }

  let tick = 0
  let status = 0
  // Notes still sounding, by channel and pitch: where each began.
  const pending = new Map<number, number>()
  const close = (key: number, midi: number) => {
    const start = pending.get(key)
    if (start === undefined) return
    pending.delete(key)
    track.notes.push({ midi, start, end: tick })
  }

  while (at < bytes.length) {
    tick += variableLength()
    const lead = bytes[at]
    if (lead === META) {
      at++
      const kind = byte()
      const length = variableLength()
      if (at + length > bytes.length) throw new Error('truncated meta')
      const data = bytes.subarray(at, at + length)
      at += length
      if (kind === META_TRACK_NAME && track.name === null) {
        try {
          track.name = new TextDecoder('utf-8', { fatal: true }).decode(data).trim()
        } catch {
          // Not UTF-8 -- an older writer's latin-1, most likely. The file
          // name will do as the title.
        }
      } else if (kind === META_TEMPO && length === 3 && track.tempo === null) {
        const microseconds = (data[0] << 16) | (data[1] << 8) | data[2]
        if (microseconds > 0) track.tempo = 60_000_000 / microseconds
      } else if (kind === META_TIME_SIGNATURE && length >= 2 && track.time === null) {
        track.time = { beats: data[0], beatType: 2 ** data[1] }
      } else if (kind === META_KEY_SIGNATURE && length >= 1 && track.keyFifths === null) {
        // A signed byte: flats are negative.
        track.keyFifths = data[0] > 127 ? data[0] - 256 : data[0]
      }
      continue
    }
    if (lead === SYSEX || lead === SYSEX_CONTINUED) {
      at++
      at += variableLength()
      continue
    }
    if (lead >= 0xf0) throw new Error(`unexpected status ${lead}`)
    // Running status: a data byte where a status byte could be repeats the
    // previous channel message's status.
    if (lead & 0x80) status = byte()
    else if (!(status & 0x80)) throw new Error('data before any status')

    const kind = status & 0xf0
    const channel = status & 0x0f
    const first = byte()
    const second = kind === PROGRAM_CHANGE || kind === CHANNEL_PRESSURE ? 0 : byte()
    if (kind === NOTE_ON && second > 0) {
      const key = (channel << 8) | first
      // A pitch restarted while it still sounds: the file means the first
      // one to stop here. That is how players treat it, and it is the only
      // reading that keeps one duration per note.
      close(key, first)
      pending.set(key, tick)
    } else if (kind === NOTE_OFF || kind === NOTE_ON) {
      close((channel << 8) | first, first)
    }
  }
  // Notes the track never switched off end where the track does.
  for (const [key, start] of pending) {
    track.notes.push({ midi: key & 0xff, start, end: tick })
  }
  return track
}

/** Every length the model can spell, by its tick count. */
const DURATIONS: ReadonlyMap<number, Duration> = new Map(
  NOTE_VALUES.flatMap((value) =>
    [
      { value, dotted: false, triplet: false },
      { value, dotted: true, triplet: false },
      { value, dotted: false, triplet: true },
    ].map((duration) => [ticks(duration), duration] as const),
  ),
)

/**
 * Which triplet value a gap's rests should take, and which side they belong
 * on: a gap after a triplet note continues its group, a gap before one opens
 * it. Null when no triplet note borders the gap.
 */
type Neighbour = { duration: Duration; side: 'before' | 'after' } | null

/**
 * Rests to cover a gap of `gap` ticks: as few as possible, and at an equal
 * count the plain ones, since those are tried first -- a gap of 20 is an
 * eighth rest and a triplet eighth, not a triplet quarter and a triplet
 * 16th. Triplet rests appear only where nothing plain adds up (8 ticks is a
 * triplet eighth and nothing else). When a triplet note borders the gap they
 * take its value and sit against it, so `musicxml.ts` sees one group: after
 * an eighth triplet, 16 ticks of silence is two triplet eighths that close
 * the bracket, not a triplet quarter that opens a second one.
 *
 * Returns null for a gap no rests spell (1, 2, 3, 5, 7 ticks), which happens
 * only when the notes around it are already off the grid -- so the caller
 * treats it as one more unrepresentable length.
 */
function restsFor(gap: number, neighbour: Neighbour): Entry[] | null {
  const candidates = [...DURATIONS.values()]
    .filter((d) => !d.triplet || neighbour === null || d.value === neighbour.duration.value)
    .sort((a, b) => Number(a.triplet) - Number(b.triplet) || ticks(b) - ticks(a))
  type Best = { count: number; last: Duration }
  const best: (Best | undefined)[] = Array.from({ length: gap + 1 })
  for (let amount = 1; amount <= gap; amount++) {
    for (const duration of candidates) {
      const remainder = amount - ticks(duration)
      if (remainder < 0 || (remainder > 0 && !best[remainder])) continue
      const count = (remainder > 0 ? best[remainder]!.count : 0) + 1
      const current = best[amount]
      if (!current || count < current.count) best[amount] = { count, last: duration }
    }
  }
  if (gap > 0 && !best[gap]) return null
  const chosen: Duration[] = []
  for (let amount = gap; amount > 0; ) {
    const duration = best[amount]!.last
    chosen.push(duration)
    amount -= ticks(duration)
  }
  // Triplet rests next to the note they group with: last when it follows
  // the gap, first when it precedes it.
  const tripletsFirst = neighbour?.side === 'after' ? -1 : 1
  chosen.sort(
    (a, b) => tripletsFirst * (Number(a.triplet) - Number(b.triplet)) || ticks(b) - ticks(a),
  )
  return chosen.map((duration) => ({ kind: 'rest', ...duration }))
}

/**
 * Strings for one beat's pitches, no string used twice. Highest pitch first,
 * each taking the highest free string that reaches it -- the same "lowest
 * fret" rule `positionFor` applies to a single note, which is what keeps a
 * lone note importing exactly where MIDI keyboard input would put it. The
 * search backtracks, so a chord that fits some way always fits; null means
 * it fits no way at all.
 */
function fingeringsFor(tuning: Tuning, pitches: number[]): Fingering[] | null {
  const descending = [...pitches].sort((a, b) => b - a)
  const place = (index: number, taken: Set<number>): Fingering[] | null => {
    if (index === descending.length) return []
    const midi = descending[index]
    for (const string of tuning) {
      const fret = midi - string.midi
      if (fret < 0 || fret > MAX_FRET || taken.has(string.number)) continue
      const rest = place(index + 1, new Set([...taken, string.number]))
      if (rest) return [{ string: string.number, fret }, ...rest]
    }
    return null
  }
  return place(0, new Set())
}

/** `end` is null when the notes of a beat stop at different times. */
type Beat = { start: number; end: number | null; pitches: number[] }

/**
 * Notes that start together, as one beat. Same-pitch doubles (two strings
 * sounding one note, collapsed on export) come back as one pitch.
 */
function beatsOf(notes: RawNote[]): Beat[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi)
  const beats: Beat[] = []
  for (const note of sorted) {
    const last = beats[beats.length - 1]
    if (last && last.start === note.start) {
      if (!last.pitches.includes(note.midi)) last.pitches.push(note.midi)
      if (last.end !== note.end) last.end = null
    } else {
      beats.push({ start: note.start, end: note.end, pitches: [note.midi] })
    }
  }
  return beats
}

export function fromMidi(bytes: Uint8Array, fallbackTitle: string): MidiImport {
  let header: Header
  try {
    header = parse(bytes)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  // A division with the high bit set is SMPTE: frames and sub-frames, real
  // time with no quarter note in it. There is no grid to align to.
  if (header.division & 0x8000) return { ok: false, reason: 'smpte' }
  if (header.division === 0) return { ok: false, reason: 'unreadable' }

  const played = header.tracks.filter((track) => track.notes.length > 0)
  if (played.length > 1) return { ok: false, reason: 'multi-track' }
  if (played.length === 0) return { ok: false, reason: 'no-notes' }
  const [track] = played

  // Scale the file's ticks onto the model's. A note that does not land on a
  // whole tick was not drawn on this grid, and reading it anyway would move
  // it.
  const scaled = (tick: number) => (tick * DIVISIONS) / header.division
  const onGrid = (note: RawNote) =>
    Number.isInteger(scaled(note.start)) && Number.isInteger(scaled(note.end))
  if (!track.notes.every(onGrid)) return { ok: false, reason: 'off-grid' }
  const notes = track.notes.map((note) => ({
    ...note,
    start: scaled(note.start),
    end: scaled(note.end),
  }))

  const base = emptyScore()
  // Meta events usually sit on the first track of a format 1 file, which may
  // hold no notes; look there too.
  const meta = <T>(pick: (track: Track) => T | null) =>
    header.tracks.map(pick).find((value) => value !== null) ?? null
  const declared = meta((t) => t.time)
  const time: TimeSignature =
    declared &&
    declared.beats >= 1 &&
    declared.beats <= 32 &&
    BEAT_TYPES.includes(declared.beatType)
      ? declared
      : base.time
  const capacity = measureCapacity(time)
  // A note below the four-string's open E is what a five-string is for, so
  // a file that has one the B string reaches is read as a five-string score
  // and the low notes land there instead of being dropped.
  const lowest = (name: TuningName) => Math.min(...TUNINGS[name].map((string) => string.midi))
  const wantsFive = (note: RawNote) => note.midi < lowest('four') && note.midi >= lowest('five')
  const tuning: TuningName = notes.some(wantsFive) ? 'five' : 'four'
  const strings = TUNINGS[tuning]

  const beats = beatsOf(notes)
  const lastEnd = Math.max(...notes.map((note) => note.end))
  const measureCount = Math.max(1, Math.ceil(lastEnd / capacity))
  if (measureCount > MAX_MEASURES) return { ok: false, reason: 'too-long' }

  let dropped = 0
  const measures: Entry[][] = Array.from({ length: measureCount }, () => [])
  let at = 0
  // The triplet note a gap follows, if any, so its rests continue the group.
  let previous: Duration | null = null
  for (const beat of beats) {
    // One duration per beat, and beats in sequence: a chord whose tones end
    // apart, or a note still held when the next beat starts (`at` is where
    // the previous beat ended), is a rhythm the model does not have.
    if (beat.end === null || beat.start < at) return { ok: false, reason: 'unsupported' }
    const duration = DURATIONS.get(beat.end - beat.start)
    if (!duration) return { ok: false, reason: 'unsupported' }
    // No ties: a note stays inside its bar.
    const measure = Math.floor(beat.start / capacity)
    if (beat.end > (measure + 1) * capacity) return { ok: false, reason: 'unsupported' }

    // Silence up to this beat, as rests -- bar by bar, since a gap may span
    // several.
    while (at < beat.start) {
      const bar = Math.floor(at / capacity)
      const until = Math.min(beat.start, (bar + 1) * capacity)
      const neighbour: Neighbour =
        until === beat.start && duration.triplet
          ? { duration, side: 'after' }
          : previous?.triplet && Math.floor((at - 1) / capacity) === bar
            ? { duration: previous, side: 'before' }
            : null
      const rests = restsFor(until - at, neighbour)
      if (!rests) return { ok: false, reason: 'unsupported' }
      measures[bar].push(...rests)
      at = until
      previous = null
    }

    let pitches = beat.pitches.filter((midi) =>
      strings.some((s) => midi >= s.midi && midi <= s.midi + MAX_FRET),
    )
    dropped += beat.pitches.length - pitches.length
    let fingerings = fingeringsFor(strings, pitches)
    // More notes than strings can hold together: keep the top, which is
    // where a bass chord's colour is, and count the rest as dropped.
    while (!fingerings && pitches.length > 0) {
      pitches = [...pitches].sort((a, b) => b - a).slice(0, -1)
      dropped++
      fingerings = fingeringsFor(strings, pitches)
    }
    measures[measure].push(
      fingerings && fingerings.length > 0
        ? { kind: 'note', notes: sortedFingerings(fingerings), ...duration }
        : { kind: 'rest', ...duration },
    )
    at = beat.end
    previous = duration
  }
  // The last bar ends at its barline like every other, so the score prints
  // the same whether the file stopped at the note or ran on in silence.
  const tail = measureCount * capacity - at
  if (tail > 0) {
    const rests = restsFor(tail, previous?.triplet ? { duration: previous, side: 'before' } : null)
    if (!rests) return { ok: false, reason: 'unsupported' }
    measures[measureCount - 1].push(...rests)
  }

  const tempo = meta((t) => t.tempo)
  const keyFifths = meta((t) => t.keyFifths)
  return {
    ok: true,
    dropped,
    score: {
      title: track.name || meta((t) => t.name) || fallbackTitle,
      keyFifths:
        keyFifths !== null && keyFifths >= -7 && keyFifths <= 7 ? keyFifths : base.keyFifths,
      time,
      tempo: tempo === null ? base.tempo : clampTempo(Math.round(tempo)),
      tuning,
      measures,
    },
  }
}
