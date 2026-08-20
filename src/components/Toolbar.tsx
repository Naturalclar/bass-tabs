import { useId, type ChangeEvent } from 'react'
import type { ScoreStatus } from '../score/useOsmd'

type Props = {
  status: ScoreStatus
  onPickFile: (file: File) => void
  onPrint: () => void
}

function statusText(status: ScoreStatus): string {
  switch (status.kind) {
    case 'empty':
      return 'MusicXML (.xml / .musicxml / .mxl) を選んでください'
    case 'loading':
      return `${status.name} を読み込み中…`
    case 'ready':
      return `${status.name} — ${status.pages} ページ (A4 縦)`
    case 'error':
      return `${status.name} を読み込めませんでした: ${status.message}`
  }
}

export function Toolbar({ status, onPickFile, onPrint }: Props) {
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
