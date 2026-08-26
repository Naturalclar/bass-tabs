import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Toolbar } from './components/Toolbar'
import { ScoreView } from './components/ScoreView'
import { EditorPanel } from './components/EditorPanel'
import { TabEditor } from './components/TabEditor'
import { useOsmd } from './score/useOsmd'
import { useEditor, type Cursor } from './editor/useEditor.ts'
import { useMidiInput } from './editor/useMidiInput.ts'
import { NOTE_VALUES, type NoteValue } from './editor/model.ts'
import { MAX_FRET, STRINGS } from './editor/tuning.ts'

export type Mode = 'open' | 'edit'

/** Keys that pick a note value, by the first letter of its English name. */
const VALUE_KEYS: Record<string, NoteValue> = { w: 1, h: 2, q: 4, e: 8, s: 16 }

/** How long consecutive digits are treated as one fret number, e.g. 1 then 2. */
const FRET_KEY_WINDOW_MS = 800

export default function App() {
  const { containerRef, loadScore, status } = useOsmd()
  const [mode, setMode] = useState<Mode>('open')
  const editor = useEditor()

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

  /**
   * The note the last placement wrote, so a following digit edits it rather
   * than starting a new note after it.
   *
   * `digits` is what a further digit appends to, and is null after a click:
   * a click carries over the previous fret, so appending to it would read the
   * first digit typed as a second digit of a number nobody entered.
   */
  const lastFret = useRef<{ at: Cursor; digits: string | null; time: number } | null>(null)

  const handleUndo = useCallback(() => {
    // The slot the current run of digits was amending may not exist after a
    // jump through history, so the next digit has to start a new fret.
    lastFret.current = null
    editor.undo()
  }, [editor])

  const handleRedo = useCallback(() => {
    lastFret.current = null
    editor.redo()
  }, [editor])

  useEffect(() => {
    if (mode !== 'edit') return
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
      if (key === 'y' || event.shiftKey) handleRedo()
      else handleUndo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleRedo, handleUndo, mode])

  const recordPlacement = useCallback((at: Cursor | null, digits: string | null) => {
    lastFret.current = at ? { at, digits, time: Date.now() } : null
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const key = event.key
      // Ctrl/Cmd combinations belong to the window handler above. Shift is not
      // one of them: it selects the string variant of the arrow keys.
      if (event.metaKey || event.ctrlKey) return
      if (/^[0-9]$/.test(key)) {
        const now = Date.now()
        const previous = lastFret.current
        event.preventDefault()
        // Frets run past 9, so a digit typed right after another extends the
        // note it just wrote -- "1" then "2" means fret 12, not 1 followed by 2.
        if (previous && now - previous.time < FRET_KEY_WINDOW_MS) {
          const digits = (previous.digits ?? '') + key
          const fret = Math.min(Number(digits), MAX_FRET)
          editor.setFretAt(previous.at, fret)
          lastFret.current = { at: previous.at, digits: String(fret), time: now }
          return
        }
        const fret = Math.min(Number(key), MAX_FRET)
        recordPlacement(editor.putNote(editor.stringNumber, fret), String(fret))
        return
      }

      // Any other key ends the run of digits: pressing 'e' then '5' means an
      // eighth note at fret 5, not fret 125 on the note before it.
      lastFret.current = null

      const value = VALUE_KEYS[key.toLowerCase()]
      if (value && NOTE_VALUES.includes(value)) {
        editor.setValue(value)
        event.preventDefault()
        return
      }

      switch (key) {
        // Up and down move the selected note by a semitone; with Shift they
        // move it across strings at the same pitch. With nothing selected there
        // is no note to move, so Shift falls back to choosing the string the
        // next note goes on -- otherwise entry by keyboard alone could not pick
        // a string at all.
        case 'ArrowUp':
        case 'ArrowDown': {
          const towardsHigherPitch = key === 'ArrowUp'
          if (!event.shiftKey) {
            editor.moveNote({ semitones: towardsHigherPitch ? 1 : -1 })
            break
          }
          editor.moveNote({ strings: towardsHigherPitch ? -1 : 1 })
          // `<string>` numbers count down from the highest-pitched string.
          editor.setStringNumber(
            towardsHigherPitch
              ? Math.max(STRINGS[0].number, editor.stringNumber - 1)
              : Math.min(STRINGS[STRINGS.length - 1].number, editor.stringNumber + 1),
          )
          break
        }
        case 'ArrowLeft':
          editor.moveCursor(-1)
          break
        case 'ArrowRight':
          editor.moveCursor(1)
          break
        case '.':
          editor.setDotted(!editor.dotted)
          break
        case 'r':
        case 'R':
          editor.putRest()
          break
        case 'Backspace':
        case 'Delete':
          editor.removeAtCursor()
          break
        default:
          return
      }
      event.preventDefault()
    },
    [editor, recordPlacement],
  )

  const handleExport = useCallback(() => {
    const blob = new Blob([editor.musicXml], { type: 'application/vnd.recordare.musicxml+xml' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${editor.score.title || 'score'}.musicxml`
    link.click()
    URL.revokeObjectURL(url)
  }, [editor.musicXml, editor.score.title])

  return (
    <>
      <Toolbar
        status={status}
        mode={mode}
        onMode={setMode}
        onPickFile={handlePickFile}
        onPrint={() => window.print()}
      />
      {mode === 'edit' && (
        <>
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
            onTitle={editor.setTitle}
            onTime={editor.setTime}
            onKeyFifths={editor.setKeyFifths}
            onMeasureCount={editor.setMeasureCount}
            onValue={editor.setValue}
            onDotted={editor.setDotted}
            onFret={editor.setFret}
            onRest={editor.putRest}
            onDelete={editor.removeAtCursor}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onConnectMidi={() => void midi.connect()}
            onExport={handleExport}
            onReset={editor.reset}
          />
          <TabEditor
            measures={editor.score.measures}
            time={editor.score.time}
            cursor={editor.cursor}
            onPlace={(at, stringNumber) =>
              recordPlacement(editor.putNote(stringNumber, editor.fret, at), null)
            }
            onKeyDown={handleKeyDown}
          />
        </>
      )}
      <ScoreView containerRef={containerRef} status={status} />
    </>
  )
}
