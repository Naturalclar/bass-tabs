import { useCallback, useEffect, useState } from 'react'
import { Toolbar } from './components/Toolbar'
import { ScoreView } from './components/ScoreView'
import { EditorPanel } from './components/EditorPanel'
import { TabEditor } from './components/TabEditor'
import { ScoreList } from './components/ScoreList'
import { VideoImport } from './components/VideoImport'
import { useOsmd } from './score/useOsmd'
import { useEditor } from './editor/useEditor.ts'
import { useEditorKeyboard } from './editor/useEditorKeyboard.ts'
import { toBackup } from './editor/backup.ts'
import { importFile, isTabImage } from './editor/importFile.ts'
import { useMidiInput } from './editor/useMidiInput.ts'
import { usePlayback } from './editor/usePlayback.ts'
import { ticksAt } from './editor/playback.ts'

export type Mode = 'open' | 'edit' | 'video'

export default function App() {
  const { containerRef, loadScore, status } = useOsmd()
  // The first thing on screen is the saved score, not an empty page waiting
  // for a file: the storage layer restores whatever was open last, so there
  // is always a score to show, and a returning user came back for theirs.
  const [mode, setMode] = useState<Mode>('edit')
  const editor = useEditor()
  const keyboard = useEditorKeyboard(editor)

  const handlePickFile = useCallback(
    (file: File) => {
      setMode('open')
      void loadScore(file, file.name)
    },
    [loadScore],
  )

  // Every edit regenerates the whole MusicXML and reloads OSMD. The scores are
  // small enough that this is cheap, and it keeps one rendering path for both
  // imported and edited scores -- so the A4 layout and the print checks apply
  // to the editor's output for free.
  useEffect(() => {
    if (mode !== 'edit') return
    void loadScore(editor.musicXml, editor.score.title)
  }, [editor.musicXml, editor.score.title, loadScore, mode])

  const midi = useMidiInput(editor.putNote)

  const playback = usePlayback(editor.score)
  const stopPlayback = playback.stop
  // Sound addresses the score that was playing when it started. Switching
  // scores -- or leaving the editor, where in video mode it would bleed into
  // the capture -- stops it: the same rule as everything else that remembers
  // a position in the score.
  useEffect(() => {
    stopPlayback()
  }, [editor.currentId, mode, stopPlayback])

  useEffect(() => {
    // The file viewer has no edits to undo; the editor and video mode do --
    // in video mode one Ctrl+Z takes back one capture.
    if (mode === 'open') return
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      // Inside a text field this belongs to the browser: undoing the score
      // while someone is fixing a typo in the title is not what they asked for.
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return
      }
      event.preventDefault()
      if (key === 'y' || event.shiftKey) keyboard.redo()
      else keyboard.undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keyboard, mode])

  const [importNotice, setImportNotice] = useState<string | null>(null)

  const handleImportFile = useCallback(
    async (file: File) => {
      // OCR takes seconds (the engine alone is megabytes, loaded lazily), so
      // the wait has to say it is one.
      if (isTabImage(file.name)) setImportNotice('画像を読み取っています…')
      const outcome = await importFile(file)
      if (outcome.scores.length > 0) editor.importScores(outcome.scores)
      setImportNotice(outcome.notice)
    },
    [editor],
  )

  const download = useCallback((text: string, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleExportAll = useCallback(() => {
    download(toBackup(editor.scores), 'bass-tabs-library.json', 'application/json')
  }, [download, editor.scores])

  const handleExport = useCallback(() => {
    download(
      editor.musicXml,
      `${editor.score.title || 'score'}.musicxml`,
      'application/vnd.recordare.musicxml+xml',
    )
  }, [download, editor.musicXml, editor.score.title])

  return (
    <>
      <Toolbar
        status={status}
        mode={mode}
        onMode={setMode}
        onPickFile={handlePickFile}
        onPrint={() => window.print()}
      />
      {(mode === 'edit' || mode === 'video') && (
        <div className="workspace">
          <ScoreList
            scores={editor.scores}
            currentId={editor.currentId}
            onSelect={editor.selectScore}
            onAdd={editor.addScore}
            onDelete={editor.deleteScore}
            onExportAll={handleExportAll}
            // importFile never rejects -- whatever goes wrong becomes the
            // notice -- so there is no failure path to leave unshown here.
            onImportFile={(file) => void handleImportFile(file)}
            notice={importNotice}
          />
          {mode === 'video' ? (
            <div className="workspace__main">
              <VideoImport onAppend={editor.appendEntries} />
            </div>
          ) : (
            <div className="workspace__main">
              <EditorPanel
                title={editor.score.title}
                time={editor.score.time}
                keyFifths={editor.score.keyFifths}
                measureCount={editor.score.measures.length}
                value={editor.value}
                dotted={editor.dotted}
                fret={editor.fret}
                remaining={editor.remaining}
                midi={midi.status}
                playing={playback.playing}
                canPlay={playback.canPlay}
                tempo={editor.score.tempo}
                onTempo={editor.setTempo}
                onTogglePlay={playback.playing ? playback.stop : playback.play}
                onTitle={editor.setTitle}
                onTime={editor.setTime}
                onKeyFifths={editor.setKeyFifths}
                onMeasureCount={editor.setMeasureCount}
                onValue={editor.setValue}
                onDotted={editor.setDotted}
                onFret={editor.setFret}
                onRest={editor.putRest}
                onDelete={editor.removeAtCursor}
                onUndo={keyboard.undo}
                onRedo={keyboard.redo}
                canUndo={editor.canUndo}
                canRedo={editor.canRedo}
                onConnectMidi={() => void midi.connect()}
                onExport={handleExport}
              />
              <TabEditor
                measures={editor.score.measures}
                time={editor.score.time}
                cursor={editor.cursor}
                playingAt={playback.position}
                onPlace={keyboard.clickLane}
                onPlayFrom={(measure) =>
                  playback.playFrom(ticksAt(editor.score, { measure, index: 0 }))
                }
                onKeyDown={keyboard.handleKeyDown}
              />
            </div>
          )}
        </div>
      )}
      {/* The score stays mounted -- OSMD owns this container -- but in video
          mode it must not be visible: the capture films this very tab, and
          staff lines on screen read as false string lines. */}
      <ScoreView containerRef={containerRef} status={status} hidden={mode === 'video'} />
    </>
  )
}
