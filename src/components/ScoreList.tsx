import { useId, type ChangeEvent } from 'react'
import type { ScoreId, StoredScore } from '../editor/storage.ts'

type Props = {
  scores: StoredScore[]
  currentId: ScoreId
  onSelect: (id: ScoreId) => void
  onAdd: () => void
  onDelete: (id: ScoreId) => void
  onExportAll: () => void
  onImportFile: (file: File) => void
  /** What the last import did, so a refused file is never silent. */
  notice: string | null
}

/**
 * The saved scores. Rows are identified by id and only labelled by title, so
 * two scores sharing a name stay distinct -- and renaming one never moves it.
 *
 * Deleting is the one action here undo cannot reach: the history describes
 * edits inside a score, not the library around it. Hence the confirmation.
 */
export function ScoreList({
  scores,
  currentId,
  onSelect,
  onAdd,
  onDelete,
  onExportAll,
  onImportFile,
  notice,
}: Props) {
  const inputId = useId()

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) onImportFile(file)
    // Reset so picking the same file again still fires a change event.
    event.target.value = ''
  }

  return (
    <aside className="sidebar" aria-label="保存した譜面">
      <div className="sidebar__head">
        <h2 className="sidebar__title">譜面</h2>
        <button type="button" className="chip" onClick={onAdd}>
          ＋ 追加
        </button>
      </div>
      <ul className="sidebar__list">
        {scores.map((entry) => {
          const current = entry.id === currentId
          return (
            <li className={`score-row${current ? ' score-row--current' : ''}`} key={entry.id}>
              <button
                type="button"
                className="score-row__open"
                aria-current={current ? 'true' : undefined}
                onClick={() => onSelect(entry.id)}
              >
                {entry.score.title || '無題'}
                <span className="score-row__meta">{entry.score.measures.length} 小節</span>
              </button>
              <button
                type="button"
                className="score-row__delete"
                aria-label={`${entry.score.title || '無題'} を削除`}
                onClick={() => {
                  if (window.confirm(`「${entry.score.title || '無題'}」を削除しますか？`)) {
                    onDelete(entry.id)
                  }
                }}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>

      <div className="sidebar__foot">
        <button type="button" className="chip" onClick={onExportAll}>
          全部書き出す
        </button>
        <label className="chip" htmlFor={inputId}>
          取り込む
          <input
            id={inputId}
            className="visually-hidden"
            type="file"
            accept=".json,.xml,.musicxml,.txt,.tab,.mid,.midi,.png,.jpg,.jpeg,.webp,.wav,.mp3,.m4a,.ogg,.flac"
            onChange={handleFile}
          />
        </label>
      </div>
      {notice && (
        <p className="sidebar__notice" role="status">
          {notice}
        </p>
      )}
    </aside>
  )
}
