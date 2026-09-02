import { NoteEntry } from './NoteEntry'
import { ScoreSettings } from './ScoreSettings'
import { Transport } from './Transport'
import type { NoteValue, TimeSignature } from '../editor/model.ts'
import type { TuningName } from '../editor/tuning.ts'
import type { MidiStatus } from '../editor/useMidiInput.ts'

/**
 * The three rows under the toolbar, each its own component: what the score is
 * (`ScoreSettings`), what the next note will be (`NoteEntry`), and sounding it
 * or getting it out (`Transport`).
 *
 * They were one component with 34 props for a while, and every feature added
 * one or two more to a type three unrelated groups shared -- so a note-value
 * change and an export change arrived as edits to the same file (#87). The
 * split is by *reason to change*, which is why the sub-fields moved with their
 * rows: `MeasureCountField` into the settings, `TempoField` into the transport.
 *
 * This component keeps taking all of them and passing each row its own, so
 * `App.tsx` did not have to change. Distributing here rather than there also
 * keeps the grouping visible in one place -- App would only show three lists
 * of props with nothing saying why they are three.
 */

type Props = {
  title: string
  time: TimeSignature
  keyFifths: number
  tuning: TuningName
  measureCount: number
  value: NoteValue
  dotted: boolean
  triplet: boolean
  fret: number
  remaining: number
  midi: MidiStatus
  playing: boolean
  paused: boolean
  canPlay: boolean
  atStart: boolean
  tempo: number
  onTempo: (tempo: number) => void
  onTogglePlay: () => void
  onStop: () => void
  onTitle: (title: string) => void
  onTime: (time: TimeSignature) => void
  onKeyFifths: (fifths: number) => void
  onTuning: (tuning: TuningName) => void
  onMeasureCount: (count: number) => void
  onValue: (value: NoteValue) => void
  onDotted: (dotted: boolean) => void
  onTriplet: (triplet: boolean) => void
  onFret: (fret: number) => void
  onRest: () => void
  onDelete: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onConnectMidi: () => void
  onExport: () => void
  onExportMidi: () => void
}

export function EditorPanel(props: Props) {
  return (
    <section className="editor-panel">
      <ScoreSettings
        title={props.title}
        time={props.time}
        keyFifths={props.keyFifths}
        tuning={props.tuning}
        measureCount={props.measureCount}
        onTitle={props.onTitle}
        onTime={props.onTime}
        onKeyFifths={props.onKeyFifths}
        onTuning={props.onTuning}
        onMeasureCount={props.onMeasureCount}
      />

      <NoteEntry
        time={props.time}
        value={props.value}
        dotted={props.dotted}
        triplet={props.triplet}
        fret={props.fret}
        remaining={props.remaining}
        canUndo={props.canUndo}
        canRedo={props.canRedo}
        onValue={props.onValue}
        onDotted={props.onDotted}
        onTriplet={props.onTriplet}
        onFret={props.onFret}
        onRest={props.onRest}
        onDelete={props.onDelete}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
      />

      <Transport
        playing={props.playing}
        paused={props.paused}
        canPlay={props.canPlay}
        atStart={props.atStart}
        tempo={props.tempo}
        midi={props.midi}
        onTogglePlay={props.onTogglePlay}
        onStop={props.onStop}
        onTempo={props.onTempo}
        onConnectMidi={props.onConnectMidi}
        onExport={props.onExport}
        onExportMidi={props.onExportMidi}
      />

      <p className="editor-help">
        レーンをクリックで音を置く。数字キーでフレット、↑↓ で半音上下、
        <kbd>Shift</kbd>+↑↓ で弦の持ち替え、←→ でカーソル移動、
        <kbd>w</kbd> <kbd>h</kbd> <kbd>q</kbd> <kbd>e</kbd> <kbd>s</kbd> で音価、
        <kbd>.</kbd> で付点、<kbd>r</kbd> で休符、<kbd>Backspace</kbd> で削除。
        <kbd>Ctrl/⌘+Z</kbd> で取り消し、<kbd>Ctrl/⌘+Shift+Z</kbd> でやり直し。
      </p>
    </section>
  )
}
