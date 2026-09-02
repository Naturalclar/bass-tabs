import { DIVISIONS, NOTE_VALUES, type NoteValue, type TimeSignature } from '../editor/model.ts'
import { MAX_FRET } from '../editor/tuning.ts'

/**
 * What the next note will be, and the operations on the one just written.
 * Split out of EditorPanel (#87).
 */

type Props = {
  time: TimeSignature
  value: NoteValue
  dotted: boolean
  triplet: boolean
  fret: number
  remaining: number
  canUndo: boolean
  canRedo: boolean
  onValue: (value: NoteValue) => void
  onDotted: (dotted: boolean) => void
  onTriplet: (triplet: boolean) => void
  onFret: (fret: number) => void
  onRest: () => void
  onDelete: () => void
  onUndo: () => void
  onRedo: () => void
}

const VALUE_LABELS: Record<NoteValue, string> = {
  1: '全',
  2: '2分',
  4: '4分',
  8: '8分',
  16: '16分',
}

export function NoteEntry(props: Props) {
  return (
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
        {/* Exclusive with 付点 -- pressing one releases the other. */}
        <button
          type="button"
          className={`chip${props.triplet ? ' chip--on' : ''}`}
          aria-pressed={props.triplet}
          onClick={() => props.onTriplet(!props.triplet)}
        >
          3 連
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
        <button type="button" className="chip" onClick={props.onUndo} disabled={!props.canUndo}>
          取り消し
        </button>
        <button type="button" className="chip" onClick={props.onRedo} disabled={!props.canRedo}>
          やり直し
        </button>
      </div>

      <span className="editor-remaining">
        {/* In the meter's own beat unit: an empty 6/8 bar has 6 left, not
            the 3 that quarter-note (DIVISIONS) arithmetic would show. */}
        この小節の残り: {props.remaining / ((DIVISIONS * 4) / props.time.beatType)} 拍
      </span>
    </div>
  )
}
