/**
 * The score as a standard MIDI file (SMF), so it can leave for a DAW or any
 * other player.
 *
 * The notes come from `schedule()` -- the same list playback sounds -- so this
 * file inherits everything that was already decided there: sounding pitch (the
 * written octave shift lives only in musicxml.ts), chords as simultaneous
 * notes, triplets, and whatever tuning the score is written for. Nothing about
 * timing is recomputed here.
 *
 * The one piece of luck worth naming: `DIVISIONS` is 24, and SMF's header
 * division *is* "ticks per quarter note". Writing 24 there makes every
 * `startTicks` and `durationTicks` land in the file unchanged -- no rescaling,
 * no rounding, no drift.
 *
 * What does not survive: strings and frets. MIDI has no concept of either, so
 * this is a one-way door -- see the note in README. Everything here is pure so
 * the bytes can be checked without a browser.
 */

import { DIVISIONS, clampTempo, type Score } from './model.ts'
import { schedule } from './playback.ts'

/** Every note the same loudness: the model has no dynamics to express. */
const VELOCITY = 100

/**
 * General MIDI program 34, "Electric Bass (finger)", as the zero-based byte
 * the wire format wants. Without it a player picks its default -- usually a
 * piano, which is a surprising thing to hear from a bass part.
 */
const GM_ELECTRIC_BASS = 33

/** Meta and channel status bytes, named so the byte soup below reads. */
const META = 0xff
const META_TRACK_NAME = 0x03
const META_TEMPO = 0x51
const META_TIME_SIGNATURE = 0x58
const META_END_OF_TRACK = 0x2f
const NOTE_OFF = 0x80
const NOTE_ON = 0x90
const PROGRAM_CHANGE = 0xc0

/**
 * A delta time, in SMF's variable-length encoding: seven bits per byte, high
 * bit set on every byte but the last.
 */
function variableLength(value: number): number[] {
  const bytes = [value & 0x7f]
  let rest = value >>> 7
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  return bytes
}

function uint16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff]
}

function uint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/** A chunk is its four-letter type, its length, then its bytes. */
function chunk(type: string, body: number[]): number[] {
  return [...[...type].map((c) => c.charCodeAt(0)), ...uint32(body.length), ...body]
}

function metaEvent(kind: number, data: number[]): number[] {
  return [META, kind, ...variableLength(data.length), ...data]
}

/**
 * Microseconds per quarter note, which is how SMF states tempo. Not every BPM
 * divides evenly (90 gives 666666.7), so the value is rounded -- the format
 * has no way to be more exact than this.
 */
function microsecondsPerQuarter(tempo: number): number {
  return Math.round(60_000_000 / clampTempo(tempo))
}

type Event = { tick: number; bytes: number[]; off: boolean }

/**
 * Writes the open score as a format 0 (single track) MIDI file. One part means
 * one track, so the extra structure of format 1 would carry nothing.
 */
export function toMidiFile(score: Score): Uint8Array<ArrayBuffer> {
  const events: Event[] = []

  // Two strings can sound the same pitch -- E string 5th fret and A string
  // open are both A1 -- and the model allows both in one chord, since they are
  // different strings. On one MIDI channel that would be two overlapping
  // note-ons for one pitch, which players resolve by cutting the note at the
  // first note-off. Collapsing them keeps the file well formed; the tab still
  // shows both fingerings.
  const seen = new Set<string>()
  for (const note of schedule(score)) {
    const key = `${note.startTicks}:${note.midi}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push({
      tick: note.startTicks,
      bytes: [NOTE_ON, note.midi, VELOCITY],
      off: false,
    })
    events.push({
      tick: note.startTicks + note.durationTicks,
      bytes: [NOTE_OFF, note.midi, 0],
      off: true,
    })
  }

  // At one tick, every note-off comes before every note-on. A note that ends
  // exactly where the next one begins is the common case here -- consecutive
  // notes on one string -- and with the on written first, the off that follows
  // would silence the note that just started.
  events.sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off))

  // The title goes in as UTF-8, which is what current DAWs write and read.
  // MIDI 1.0 predates that and calls text events ASCII without a way to
  // declare an encoding, so a strict reader decodes these bytes as latin-1
  // and shows mojibake for a Japanese title (mido does exactly this). There
  // is no encoding that satisfies both; the file name carries the title
  // reliably, and this event is the nicety.
  const title = new TextEncoder().encode(score.title)
  const tempo = microsecondsPerQuarter(score.tempo)
  const track: number[] = [
    ...variableLength(0),
    ...metaEvent(META_TRACK_NAME, [...title]),
    ...variableLength(0),
    ...metaEvent(META_TEMPO, [(tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff]),
    ...variableLength(0),
    ...metaEvent(META_TIME_SIGNATURE, [
      score.time.beats,
      // SMF states the denominator as a power of two, so 4 is 2 and 8 is 3.
      Math.log2(score.time.beatType),
      // The conventional pair: 24 MIDI clocks per metronome click, and 8
      // thirty-second notes per quarter. Nothing here varies them.
      24,
      8,
    ]),
    ...variableLength(0),
    PROGRAM_CHANGE,
    GM_ELECTRIC_BASS,
  ]

  let previous = 0
  for (const event of events) {
    track.push(...variableLength(event.tick - previous), ...event.bytes)
    previous = event.tick
  }
  track.push(...variableLength(0), ...metaEvent(META_END_OF_TRACK, []))

  return new Uint8Array([
    // format 0, one track, DIVISIONS ticks per quarter note.
    ...chunk('MThd', [...uint16(0), ...uint16(1), ...uint16(DIVISIONS)]),
    ...chunk('MTrk', track),
  ])
}
