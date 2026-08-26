import type { RefObject } from 'react'
import type { ScoreStatus } from '../score/useOsmd'

type Props = {
  containerRef: RefObject<HTMLDivElement | null>
  status: ScoreStatus
  /** display:none, not unmount: OSMD owns the container across mode changes. */
  hidden?: boolean
}

export function ScoreView({ containerRef, status, hidden = false }: Props) {
  return (
    <main className="sheet" hidden={hidden}>
      {status.kind === 'empty' && (
        <p className="sheet__placeholder">
          MusicXML を開くと、A4 縦に組まれた楽譜がここに表示されます。
        </p>
      )}
      <div className="sheet__pages" ref={containerRef} />
    </main>
  )
}
