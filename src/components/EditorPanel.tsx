import { DIVISIONS, NOTE_VALUES, type NoteValue, type TimeSignature } from '../editor/model.ts'
import { MAX_FRET } from '../editor/tuning.ts'
import type { MidiStatus } from '../editor/useMidiInput.ts'

type Props = {
  title: string
  time: TimeSignature
  keyFifths: number
  measureCount: number
  value: NoteValue
  dotted: boolean
  fret: number
  remaining: number
  midi: MidiStatus
  onTitle: (title: string) => void
  onTime: (time: TimeSignature) => void
  onKeyFifths: (fifths: number) => void
  onMeasureCount: (count: number) => void
  onValue: (value: NoteValue) => void
  onDotted: (dotted: boolean) => void
  onFret: (fret: number) => void
  onRest: () => void
  onDelete: () => void
  onConnectMidi: () => void
  onExport: () => void
  onReset: () => void
}

const TIMES: TimeSignature[] = [
  { beats: 4, beatType: 4 },
  { beats: 3, beatType: 4 },
  { beats: 2, beatType: 4 },
  { beats: 6, beatType: 8 },
]

/** Key names by circle-of-fifths count, which is what MusicXML stores. */
const KEYS: { fifths: number; label: string }[] = [
  { fifths: -4, label: 'A♭' },
  { fifths: -3, label: 'E♭' },
  { fifths: -2, label: 'B♭' },
  { fifths: -1, label: 'F' },
  { fifths: 0, label: 'C' },
  { fifths: 1, label: 'G' },
  { fifths: 2, label: 'D' },
  { fifths: 3, label: 'A' },
  { fifths: 4, label: 'E' },
]

const VALUE_LABELS: Record<NoteValue, string> = {
  1: '全',
  2: '2分',
  4: '4分',
  8: '8分',
  16: '16分',
}

function midiLabel(status: MidiStatus): string {
  switch (status.kind) {
    case 'unsupported':
      return 'MIDI 非対応のブラウザ'
    case 'denied':
      return 'MIDI が拒否されました'
    case 'connected':
      return status.inputs.length > 0 ? `MIDI: ${status.inputs.join(', ')}` : 'MIDI 入力が見つかりません'
    case 'idle':
      return 'MIDI キーボードを使う'
  }
}

export function EditorPanel(props: Props) {
  return (
    <section className="editor-panel">
      <div className="editor-row">
        <label className="editor-field">
          曲名
          <input value={props.title} onChange={(e) => props.onTitle(e.target.value)} />
        </label>
        <label className="editor-field">
          拍子
          <select
            value={`${props.time.beats}/${props.time.beatType}`}
            onChange={(e) => {
              const [beats, beatType] = e.target.value.split('/').map(Number)
              props.onTime({ beats, beatType })
            }}
          >
            {TIMES.map((time) => (
              <option key={`${time.beats}/${time.beatType}`} value={`${time.beats}/${time.beatType}`}>
                {time.beats}/{time.beatType}
              </option>
            ))}
          </select>
        </label>
        <label className="editor-field">
          調
          <select
            value={props.keyFifths}
            onChange={(e) => props.onKeyFifths(Number(e.target.value))}
          >
            {KEYS.map((key) => (
              <option key={key.fifths} value={key.fifths}>
                {key.label}
              </option>
            ))}
          </select>
        </label>
        <label className="editor-field">
          小節数
          <input
            type="number"
            min={1}
            max={64}
            value={props.measureCount}
            onChange={(e) => props.onMeasureCount(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="editor-row">
        <div className="editor-field editor-field--group" role="group" aria-label="音価">
          {NOTE_VALUES.map((value) => (
            <button
              type="button"
              key={value}
              className={`chip${props.value === value ? ' chip--on' : ''}`}
              onClick={() => props.onValue(value)}
            >
              {VALUE_LABELS[value]}
            </button>
          ))}
          <button
            type="button"
            className={`chip${props.dotted ? ' chip--on' : ''}`}
            aria-pressed={props.dotted}
            onClick={() => props.onDotted(!props.dotted)}
          >
            付点
          </button>
        </div>

        <label className="editor-field">
          フレット
          <input
            type="number"
            min={0}
            max={MAX_FRET}
            value={props.fret}
            onChange={(e) => props.onFret(Number(e.target.value))}
          />
        </label>

        <div className="editor-field editor-field--group">
          <button type="button" className="chip" onClick={props.onRest}>
            休符
          </button>
          <button type="button" className="chip" onClick={props.onDelete}>
            削除
          </button>
        </div>

        <span className="editor-remaining">この小節の残り: {props.remaining / DIVISIONS} 拍</span>
      </div>

      <div className="editor-row">
        <button
          type="button"
          className="button"
          onClick={props.onConnectMidi}
          disabled={props.midi.kind === 'unsupported' || props.midi.kind === 'connected'}
        >
          {midiLabel(props.midi)}
        </button>
        <button type="button" className="button" onClick={props.onExport}>
          MusicXML を書き出す
        </button>
        <button type="button" className="button" onClick={props.onReset}>
          新規
        </button>
      </div>

      <p className="editor-help">
        レーンをクリックで音を置く。数字キーでフレット、↑↓ で弦、←→ でカーソル移動、
        <kbd>w</kbd> <kbd>h</kbd> <kbd>q</kbd> <kbd>e</kbd> <kbd>s</kbd> で音価、
        <kbd>.</kbd> で付点、<kbd>r</kbd> で休符、<kbd>Backspace</kbd> で削除。
      </p>
    </section>
  )
}
