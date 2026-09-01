import { DIVISIONS, measureCapacity, ticks, type Entry, type NoteValue, type Score } from './model.ts'
import { TUNINGS, midiFor, pitchFor, staffLine, type Tuning } from './tuning.ts'

/**
 * Serialises the editor's model to MusicXML.
 *
 * The shape follows `public/samples/bass-tab.musicxml`, which is the file the
 * print checks already verify OSMD renders: one part with two staves, every
 * event written twice -- once on the notation staff and again on the tab staff
 * after a `<backup>` -- rather than two parts. Deviating from that shape means
 * re-verifying how OSMD lays it out, so don't.
 */

/**
 * Bass is written an octave above where it sounds, and this file follows that.
 * Written at pitch, the open E string sits three ledger lines below the bass
 * staff and everything low is unreadable -- measured on the two-page sample,
 * writing at pitch draws 201 ledger-line elements where writing up draws 10.
 *
 * The shift lives here and nowhere else. `tuning.ts` stays at sounding pitch,
 * because that is what the fret arithmetic and MIDI input are about; only the
 * moment of writing MusicXML moves.
 */
const WRITTEN_OCTAVE_SHIFT = 12

const TYPE_NAMES: Record<NoteValue, string> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: '16th',
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;',
  )
}

/**
 * Fills the tail of a short measure with rests. The model stores only what was
 * entered, but a measure that does not add up to its time signature renders
 * with the barline in the wrong place, so the padding happens here rather than
 * being forced on the person typing.
 */
function padded(entries: Entry[], capacity: number): Entry[] {
  const padding: Entry[] = []

  // A triplet is three notes in one bracket, but they are entered one at a
  // time, so a bar in progress is nearly always sitting on a group of one or
  // two. Closing it with triplet rests is the same bargain padded() already
  // strikes for a short bar: the model holds what was entered, and the
  // serialiser makes it well-formed notation.
  let run = 0
  let runValue: NoteValue | null = null
  for (const entry of entries) {
    if (entry.triplet && (runValue === null || entry.value === runValue)) {
      runValue = entry.value
      run = (run + 1) % 3
    } else if (entry.triplet) {
      runValue = entry.value
      run = 1
    } else {
      run = 0
      runValue = null
    }
  }
  if (run > 0 && runValue !== null) {
    for (let i = run; i < 3; i++) {
      padding.push({ kind: 'rest', value: runValue, dotted: false, triplet: true })
    }
  }

  let remaining =
    capacity -
    entries.reduce((sum, e) => sum + ticks(e), 0) -
    padding.reduce((sum, e) => sum + ticks(e), 0)
  // Largest value first, so the rest of a half-empty 4/4 bar is one half rest
  // rather than eight sixteenths.
  for (const value of [1, 2, 4, 8, 16] as NoteValue[]) {
    for (const dotted of [true, false]) {
      const rest: Entry = { kind: 'rest', value, dotted, triplet: false }
      while (remaining >= ticks(rest)) {
        padding.push(rest)
        remaining -= ticks(rest)
      }
    }
  }
  return [...entries, ...padding]
}

/**
 * Where each entry sits in its tuplet: 0, 1, 2 for a triplet's three, null
 * for anything outside one. The brackets are derived here rather than stored,
 * so the model can stay a flat list -- see `Duration` in model.ts.
 */
function tupletPositions(entries: Entry[]): (number | null)[] {
  let run = 0
  let runValue: NoteValue | null = null
  return entries.map((entry) => {
    if (!entry.triplet) {
      run = 0
      runValue = null
      return null
    }
    if (runValue !== entry.value) {
      runValue = entry.value
      run = 0
    }
    const position = run
    run = (run + 1) % 3
    return position
  })
}

function noteXml(
  entry: Entry,
  staff: 1 | 2,
  keyFifths: number,
  tuning: Tuning,
  /** 0, 1 or 2 within a triplet; null outside one. */
  tuplet: number | null,
): string {
  const duration = ticks(entry)
  // Three in the time of two, and the bracket drawn on the first and last of
  // the group. OSMD renders both the number and the bracket, on the notation
  // staff and the tab staff alike (verified on a two-page sample).
  const modification = entry.triplet
    ? '        <time-modification><actual-notes>3</actual-notes>' +
      '<normal-notes>2</normal-notes></time-modification>\n'
    : ''
  const bracket =
    tuplet === 0
      ? '<tuplet type="start" bracket="yes" show-number="actual"/>'
      : tuplet === 2
        ? '<tuplet type="stop"/>'
        : ''
  const tail = (technical: string) =>
    `        <duration>${duration}</duration>\n` +
    '        <voice>1</voice>\n' +
    `        <type>${TYPE_NAMES[entry.value]}</type>\n` +
    (entry.dotted ? '        <dot/>\n' : '') +
    modification +
    `        <staff>${staff}</staff>\n` +
    technical +
    '      </note>\n'

  if (entry.kind === 'rest') {
    return (
      '      <note>\n        <rest/>\n' +
      tail(bracket === '' ? '' : `        <notations>${bracket}</notations>\n`)
    )
  }

  // A chord is the same <note> element once per string, every one after the
  // first opening with <chord/> so it shares the first one's moment instead
  // of advancing time. Each carries its own duration all the same -- that is
  // how the reference sample (and the spec) writes it.
  return entry.notes
    .map((fingering, index) => {
      const { step, alter, octave } = pitchFor(
        midiFor(tuning, fingering.string, fingering.fret) + WRITTEN_OCTAVE_SHIFT,
        keyFifths,
      )
      // The bracket belongs to the beat, so only the first chord tone carries
      // it -- a <tuplet> on every string would open the group three times.
      const marks =
        (index === 0 ? bracket : '') +
        (staff === 2
          ? `<technical><string>${fingering.string}</string><fret>${fingering.fret}</fret></technical>`
          : '')
      const technical = marks === '' ? '' : `        <notations>${marks}</notations>\n`
      return (
        '      <note>\n' +
        (index > 0 ? '        <chord/>\n' : '') +
        '        <pitch>\n' +
        `          <step>${step}</step>\n` +
        (alter === 0 ? '' : `          <alter>${alter}</alter>\n`) +
        `          <octave>${octave}</octave>\n` +
        '        </pitch>\n' +
        tail(technical)
      )
    })
    .join('')
}

function attributesXml(score: Score): string {
  const tuning = TUNINGS[score.tuning]
  const tunings = [...tuning]
    .sort((a, b) => staffLine(tuning, a.number) - staffLine(tuning, b.number))
    .map(
      (s) =>
        `          <staff-tuning line="${staffLine(tuning, s.number)}">` +
        `<tuning-step>${s.step}</tuning-step>` +
        `<tuning-octave>${s.octave + 1}</tuning-octave></staff-tuning>\n`,
    )
    .join('')

  return (
    '      <attributes>\n' +
    `        <divisions>${DIVISIONS}</divisions>\n` +
    `        <key><fifths>${score.keyFifths}</fifths></key>\n` +
    `        <time><beats>${score.time.beats}</beats>` +
    `<beat-type>${score.time.beatType}</beat-type></time>\n` +
    '        <staves>2</staves>\n' +
    // Says the part sounds an octave below what is written, so the file states
    // the real pitch even though the notes are written up. OSMD ignores this
    // for display (verified), which is what makes the two compatible.
    '        <transpose>\n' +
    '          <chromatic>0</chromatic>\n' +
    '          <octave-change>-1</octave-change>\n' +
    '        </transpose>\n' +
    '        <clef number="1"><sign>F</sign><line>4</line></clef>\n' +
    '        <clef number="2"><sign>TAB</sign><line>5</line></clef>\n' +
    '        <staff-details number="2" print-object="yes">\n' +
    `          <staff-lines>${tuning.length}</staff-lines>\n` +
    tunings +
    '        </staff-details>\n' +
    '      </attributes>\n'
  )
}

/**
 * The printed tempo: ♩=N above the first system (bass-chart convention), and
 * the same number as <sound tempo> so other software plays it at this speed.
 * MusicXML's sound tempo is quarter notes per minute, which is exactly what
 * `score.tempo` means whatever the meter.
 */
function tempoXml(tempo: number): string {
  return (
    '      <direction placement="above">\n' +
    '        <direction-type><metronome><beat-unit>quarter</beat-unit>' +
    `<per-minute>${tempo}</per-minute></metronome></direction-type>\n` +
    `        <sound tempo="${tempo}"/>\n` +
    '      </direction>\n'
  )
}

export function toMusicXml(score: Score): string {
  const capacity = measureCapacity(score.time)

  const measures = score.measures
    .map((entries, index) => {
      const full = padded(entries, capacity)
      const tuplets = tupletPositions(full)
      const tuning = TUNINGS[score.tuning]
      const notation = full
        .map((e, i) => noteXml(e, 1, score.keyFifths, tuning, tuplets[i]))
        .join('')
      const tab = full.map((e, i) => noteXml(e, 2, score.keyFifths, tuning, tuplets[i])).join('')
      return (
        `    <measure number="${index + 1}">\n` +
        (index === 0 ? attributesXml(score) + tempoXml(score.tempo) : '') +
        notation +
        `      <backup><duration>${capacity}</duration></backup>\n` +
        tab +
        '    </measure>\n'
      )
    })
    .join('')

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
    '"http://www.musicxml.org/dtds/partwise.dtd">\n' +
    '<score-partwise version="4.0">\n' +
    `  <work><work-title>${escapeXml(score.title)}</work-title></work>\n` +
    '  <part-list>\n' +
    '    <score-part id="P1"><part-name>Bass</part-name></score-part>\n' +
    '  </part-list>\n' +
    '  <part id="P1">\n' +
    measures +
    '  </part>\n' +
    '</score-partwise>\n'
  )
}
