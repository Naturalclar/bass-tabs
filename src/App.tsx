import { useCallback } from 'react'
import { Toolbar } from './components/Toolbar'
import { ScoreView } from './components/ScoreView'
import { useOsmd } from './score/useOsmd'

export default function App() {
  const { containerRef, loadScore, status } = useOsmd()

  const handlePickFile = useCallback(
    (file: File) => {
      void loadScore(file, file.name)
    },
    [loadScore],
  )

  return (
    <>
      <Toolbar status={status} onPickFile={handlePickFile} onPrint={() => window.print()} />
      <ScoreView containerRef={containerRef} status={status} />
    </>
  )
}
