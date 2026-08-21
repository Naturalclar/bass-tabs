import { useId, type ChangeEvent } from 'react'
import type { ScoreStatus } from '../score/useOsmd'
import type { Mode } from '../App'

type Props = {
  status: ScoreStatus
  mode: Mode
  onMode: (mode: Mode) => void
  onPickFile: (file: File) => void
  onPrint: () => void
}

function statusText(status: ScoreStatus): string {
  switch (status.kind) {
    case 'empty':
      return 'MusicXML を開くか、画面上で作ってください'
    case 'loading':
      return `${status.name} を読み込み中…`
    case 'ready':
      return `${status.name} — ${status.pages} ページ (A4 縦)`
    case 'error':
      return `${status.name} を読み込めませんでした: ${status.message}`
  }
}

export function Toolbar({ status, mode, onMode, onPickFile, onPrint }: Props) {
  const inputId = useId()

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) onPickFile(file)
    // Reset so picking the same file again still fires a change event.
    event.target.value = ''
  }

  return (
    <header className="toolbar">
      <h1 className="toolbar__title">bass-tabs</h1>
      <button
        type="button"
        className={`button${mode === 'edit' ? ' button--on' : ''}`}
        aria-pressed={mode === 'edit'}
        onClick={() => onMode(mode === 'edit' ? 'open' : 'edit')}
      >
        譜面を作る
      </button>
      <label className="button" htmlFor={inputId}>
        ファイルを開く
        <input
          id={inputId}
          className="visually-hidden"
          type="file"
          accept=".xml,.musicxml,.mxl,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml"
          onChange={handleChange}
        />
      </label>
      <button
        className="button"
        type="button"
        onClick={onPrint}
        disabled={status.kind !== 'ready'}
      >
        印刷
      </button>
      <p
        className={`toolbar__status${status.kind === 'error' ? ' toolbar__status--error' : ''}`}
        role="status"
      >
        {statusText(status)}
      </p>
    </header>
  )
}
