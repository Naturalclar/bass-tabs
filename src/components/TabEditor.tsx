import type { Entry } from '../editor/model.ts'
import { STRINGS } from '../editor/tuning.ts'
import type { Cursor } from '../editor/useEditor.ts'

type Props = {
  measures: Entry[][]
  cursor: Cursor
  /** Writes at the clicked slot; the cursor follows from the write. */
  onPlace: (at: Cursor, stringNumber: number) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}

const VALUE_LABELS: Record<number, string> = { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯' }

function entryLabel(entry: Entry): string {
  return `${VALUE_LABELS[entry.value] ?? entry.value}${entry.dotted ? '.' : ''}`
}

/**
 * The tab grid. One column per entry, four lanes per column -- the same layout
 * as tab on paper, so a column is a moment in time and a lane is a string.
 *
 * Clicking a lane writes there, which is both the click entry method and the
 * way the cursor moves. The trailing column of each measure is the append slot.
 * The click passes its own slot to the writer rather than moving the cursor and
 * letting the write find it -- see `place()` in useEditor for why.
 */
export function TabEditor({ measures, cursor, onPlace, onKeyDown }: Props) {
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
            {[...entries, null].map((entry, index) => {
              const selected = cursor.measure === measureIndex && cursor.index === index
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
