import { useState } from 'react'
import { MAX_MEASURES, type TimeSignature } from '../editor/model.ts'
import { TUNING_LABELS, type TuningName } from '../editor/tuning.ts'

/**
 * The attributes of the score itself: what it is, not what you are about to
 * write into it. Split out of EditorPanel (#87) because the three rows of that
 * panel change for different reasons and were sharing one 34-prop type.
 */

type Props = {
  title: string
  time: TimeSignature
  keyFifths: number
  tuning: TuningName
  measureCount: number
  onTitle: (title: string) => void
  onTime: (time: TimeSignature) => void
  onKeyFifths: (fifths: number) => void
  onTuning: (tuning: TuningName) => void
  onMeasureCount: (count: number) => void
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

/**
 * The measure count, applied when the edit is finished rather than on every
 * keystroke. Lowering the count drops measures and everything written in them,
 * so a value passing through on the way to another one must not reach the
 * score: typing "12" over "4" would otherwise truncate to a single measure at
 * the "1" and take bars 2-4 with it, and nothing here can undo that.
 */
function MeasureCountField({
  count,
  onCommit,
}: {
  count: number
  onCommit: (count: number) => void
}) {
  const [draft, setDraft] = useState(String(count))
  const [shown, setShown] = useState(count)
  // Adjusting during render rather than in an effect: 新規 resets the count
  // behind our back, and the draft has to follow it without a second paint.
  if (count !== shown) {
    setShown(count)
    setDraft(String(count))
  }

  function commit() {
    const parsed = Number(draft)
    // An empty or unparseable field means the person did not finish a number;
    // put back what the score actually holds rather than clamping to 1.
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(count))
      return
    }
    const clamped = Math.min(Math.max(Math.round(parsed), 1), MAX_MEASURES)
    setDraft(String(clamped))
    if (clamped !== count) onCommit(clamped)
  }

  return (
    <label className="editor-field">
      小節数
      <input
        type="number"
        min={1}
        max={MAX_MEASURES}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') setDraft(String(count))
        }}
      />
    </label>
  )
}

export function ScoreSettings(props: Props) {
  return (
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
        <select value={props.keyFifths} onChange={(e) => props.onKeyFifths(Number(e.target.value))}>
          {KEYS.map((key) => (
            <option key={key.fifths} value={key.fifths}>
              {key.label}
            </option>
          ))}
        </select>
      </label>
      <label className="editor-field">
        {/* Not just "弦": every lane button in the grid is named "… E 弦",
            and a bare 弦 would be ambiguous to both a screen reader and the
            e2e checks. */}
        チューニング
        <select
          value={props.tuning}
          onChange={(e) => props.onTuning(e.target.value as TuningName)}
        >
          {(Object.keys(TUNING_LABELS) as TuningName[]).map((name) => (
            <option key={name} value={name}>
              {TUNING_LABELS[name]}
            </option>
          ))}
        </select>
      </label>
      <MeasureCountField count={props.measureCount} onCommit={props.onMeasureCount} />
    </div>
  )
}
