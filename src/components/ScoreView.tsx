import type { RefObject } from 'react'
import type { ScoreStatus } from '../score/useOsmd'

type Props = {
  containerRef: RefObject<HTMLDivElement | null>
  status: ScoreStatus
}

export function ScoreView({ containerRef, status }: Props) {
  return (
    <main className="sheet">
      {status.kind === 'empty' && (
        <p className="sheet__placeholder">
          MusicXML を開くと、A4 縦に組まれた楽譜がここに表示されます。
        </p>
      )}
      <div className="sheet__pages" ref={containerRef} />
    </main>
  )
}
