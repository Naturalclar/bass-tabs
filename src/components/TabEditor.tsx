import { measureRemaining, type Entry, type TimeSignature } from '../editor/model.ts'
import { STRINGS } from '../editor/tuning.ts'
import type { Cursor } from '../editor/useEditor.ts'

type Props = {
  measures: Entry[][]
  time: TimeSignature
  cursor: Cursor
  /** Writes at the clicked slot; the cursor follows from the write. */
  onPlace: (at: Cursor, stringNumber: number) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}

const VALUE_LABELS: Record<number, string> = { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯' }

/** The measure's entries, plus a trailing append slot while anything still fits. */
function appendableColumns(entries: Entry[], time: TimeSignature): (Entry | null)[] {
  return measureRemaining(entries, time) > 0 ? [...entries, null] : entries
}

function entryLabel(entry: Entry): string {
  return `${VALUE_LABELS[entry.value] ?? entry.value}${entry.dotted ? '.' : ''}`
}

/**
 * The tab grid. One column per entry, four lanes per column -- the same layout
 * as tab on paper, so a column is a moment in time and a lane is a string.
 *
 * Clicking a lane writes there, which is both the click entry method and the
 * way the cursor moves. The click passes its own slot to the writer rather than
 * moving the cursor and letting the write find it -- see `place()` in useEditor
 * for why.
 *
 * Each measure ends with an append slot, dropped once the measure is full: a
 * slot that can only refuse what you put in it is worse than no slot.
 */
export function TabEditor({ measures, time, cursor, onPlace, onKeyDown }: Props) {
  return (
    <div
      className="tab-editor"
      tabIndex={0}
      role="application"
      aria-label="タブ譜エディタ"
      onKeyDown={onKeyDown}
    >
      {measures.map((entries, measureIndex) => (
        <div className="tab-measure" key={measureIndex}>
          <span className="tab-measure__number">{measureIndex + 1}</span>
          <div className="tab-measure__grid">
            {appendableColumns(entries, time).map((entry, index, columns) => {
              // With the append slot gone the cursor can sit past the last
              // column, so the highlight falls back to the final one -- which
              // is also the note the arrow keys move.
              const highlighted = Math.min(cursor.index, columns.length - 1)
              const selected = cursor.measure === measureIndex && highlighted === index
              return (
                <div
                  className={`tab-column${selected ? ' tab-column--selected' : ''}${
                    entry ? '' : ' tab-column--append'
                  }`}
                  key={index}
                >
                  <span className="tab-column__value">{entry ? entryLabel(entry) : '+'}</span>
                  {STRINGS.map((string) => {
                    const here = entry?.kind === 'note' && entry.string === string.number
                    return (
                      <button
                        type="button"
                        className={`tab-cell${here ? ' tab-cell--note' : ''}`}
                        key={string.number}
                        aria-label={`${measureIndex + 1} 小節目 ${index + 1} 番目 ${string.label} 弦`}
                        onClick={() => onPlace({ measure: measureIndex, index }, string.number)}
                      >
                        {here ? entry.fret : entry?.kind === 'rest' ? '' : '−'}
                      </button>
                    )
                  })}
                  {entry?.kind === 'rest' && <span className="tab-column__rest">休</span>}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
