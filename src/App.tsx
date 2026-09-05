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
import { isAsciiTab } from './editor/asciiTab.ts'
import { importFile, isAudioFile, isTabImage } from './editor/importFile.ts'
import { toMidiFile } from './editor/midiFile.ts'
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

  const midi = useMidiInput(editor.putNote, editor.score.tuning)

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

  useEffect(() => {
    // The editor's key scheme is window-level too, not just on `.tab-editor`.
    // The transport buttons (再生 / 一時停止 / 停止) sit outside the grid and
    // keep focus after a click, so pausing and then typing a fret used to go
    // nowhere -- no note, no error. Same guards as the undo handler above:
    // text fields (and selects, which use keys natively) own their keys, and
    // anything inside `.tab-editor` is already handled by the grid's own
    // onKeyDown -- taking it here as well would write every note twice.
    if (mode !== 'edit') return
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) return
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        target?.closest('.tab-editor')
      ) {
        return
      }
      keyboard.handleKeyDown(event)
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
      else if (isAudioFile(file.name)) setImportNotice('音声を読み取っています…')
      const outcome = await importFile(file)
      if (outcome.scores.length > 0) editor.importScores(outcome.scores)
      setImportNotice(outcome.notice)
    },
    [editor],
  )

  useEffect(() => {
    // Pasting an ASCII tab anywhere in the editor imports it as a new score,
    // through the same path as a .txt file so the two cannot drift. Text
    // fields keep their paste; prose pasted elsewhere is left alone, and only
    // something with tab lines in it gets read -- or refused with a reason.
    if (mode !== 'edit') return
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return
      }
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!isAsciiTab(text)) return
      event.preventDefault()
      void handleImportFile(new File([text], '貼り付けたタブ.txt', { type: 'text/plain' }))
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [handleImportFile, mode])

  // Takes bytes as well as text: a MIDI file is binary, and a string-only
  // helper would have written its digits out as characters. The type argument
  // is spelled out because a bare `Uint8Array` also admits a SharedArrayBuffer,
  // which `Blob` will not take.
  const download = useCallback(
    (data: string | Uint8Array<ArrayBuffer>, name: string, type: string) => {
      const url = URL.createObjectURL(new Blob([data], { type }))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      URL.revokeObjectURL(url)
    },
    [],
  )

  // Stop is "start over": silence the run, drop any pause, and put the cursor
  // back at the top so the next play -- and the next keystroke -- begin where
  // the last run did.
  const handleStop = useCallback(() => {
    playback.stop()
    editor.resetCursor()
  }, [editor, playback])

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

  const handleExportMidi = useCallback(() => {
    download(toMidiFile(editor.score), `${editor.score.title || 'score'}.mid`, 'audio/midi')
  }, [download, editor.score])

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
              <VideoImport onAppend={editor.appendEntries} time={editor.score.time} />
            </div>
          ) : (
            <div className="workspace__main">
              <EditorPanel
                title={editor.score.title}
                time={editor.score.time}
                keyFifths={editor.score.keyFifths}
                tuning={editor.score.tuning}
                measureCount={editor.score.measures.length}
                value={editor.value}
                dotted={editor.dotted}
                triplet={editor.triplet}
                fret={editor.fret}
                remaining={editor.remaining}
                midi={midi.status}
                playing={playback.playing}
                paused={playback.paused}
                canPlay={playback.canPlay}
                atStart={editor.cursor.measure === 0 && editor.cursor.index === 0}
                tempo={editor.score.tempo}
                onTempo={editor.setTempo}
                onTogglePlay={playback.playing ? playback.pause : playback.play}
                onStop={handleStop}
                onTitle={editor.setTitle}
                onTime={editor.setTime}
                onKeyFifths={editor.setKeyFifths}
                onTuning={editor.setTuning}
                onMeasureCount={editor.setMeasureCount}
                onValue={editor.setValue}
                onDotted={editor.setDotted}
                onTriplet={editor.setTriplet}
                onFret={editor.setFret}
                onRest={editor.putRest}
                onDelete={editor.removeAtCursor}
                onUndo={keyboard.undo}
                onRedo={keyboard.redo}
                canUndo={editor.canUndo}
                canRedo={editor.canRedo}
                onConnectMidi={() => void midi.connect()}
                onExport={handleExport}
                onExportMidi={handleExportMidi}
              />
              <TabEditor
                measures={editor.score.measures}
                time={editor.score.time}
                tuning={editor.score.tuning}
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
