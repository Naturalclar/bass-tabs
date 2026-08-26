import { DIVISIONS, measureCapacity, ticks, type Entry, type NoteValue, type Score } from './model.ts'
import { STRINGS, midiFor, pitchFor, staffLine } from './tuning.ts'

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
  let remaining = capacity - entries.reduce((sum, e) => sum + ticks(e.value, e.dotted), 0)
  const padding: Entry[] = []
  // Largest value first, so the rest of a half-empty 4/4 bar is one half rest
  // rather than eight sixteenths.
  for (const value of [1, 2, 4, 8, 16] as NoteValue[]) {
    for (const dotted of [true, false]) {
      while (remaining >= ticks(value, dotted)) {
        padding.push({ kind: 'rest', value, dotted })
        remaining -= ticks(value, dotted)
      }
    }
  }
  return [...entries, ...padding]
}

function noteXml(entry: Entry, staff: 1 | 2, keyFifths: number): string {
  const duration = ticks(entry.value, entry.dotted)
  const tail = (technical: string) =>
    `        <duration>${duration}</duration>\n` +
    '        <voice>1</voice>\n' +
    `        <type>${TYPE_NAMES[entry.value]}</type>\n` +
    (entry.dotted ? '        <dot/>\n' : '') +
    `        <staff>${staff}</staff>\n` +
    technical +
    '      </note>\n'

  if (entry.kind === 'rest') return '      <note>\n        <rest/>\n' + tail('')

  // A chord is the same <note> element once per string, every one after the
  // first opening with <chord/> so it shares the first one's moment instead
  // of advancing time. Each carries its own duration all the same -- that is
  // how the reference sample (and the spec) writes it.
  return entry.notes
    .map((fingering, index) => {
      const { step, alter, octave } = pitchFor(
        midiFor(fingering.string, fingering.fret) + WRITTEN_OCTAVE_SHIFT,
        keyFifths,
      )
      const technical =
        staff === 2
          ? `        <notations><technical><string>${fingering.string}</string>` +
            `<fret>${fingering.fret}</fret></technical></notations>\n`
          : ''
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
  const tunings = [...STRINGS]
    .sort((a, b) => staffLine(a.number) - staffLine(b.number))
    .map(
      (s) =>
        `          <staff-tuning line="${staffLine(s.number)}">` +
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
    `          <staff-lines>${STRINGS.length}</staff-lines>\n` +
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
      const notation = full.map((e) => noteXml(e, 1, score.keyFifths)).join('')
      const tab = full.map((e) => noteXml(e, 2, score.keyFifths)).join('')
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
