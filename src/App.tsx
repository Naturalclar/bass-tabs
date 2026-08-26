import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Toolbar } from './components/Toolbar'
import { ScoreView } from './components/ScoreView'
import { EditorPanel } from './components/EditorPanel'
import { TabEditor } from './components/TabEditor'
import { ScoreList } from './components/ScoreList'
import { VideoImport } from './components/VideoImport'
import { useOsmd } from './score/useOsmd'
import { useEditor, type Cursor } from './editor/useEditor.ts'
import type { ScoreId } from './editor/storage.ts'
import { fromBackup, toBackup } from './editor/backup.ts'
import { fromMusicXml } from './editor/musicxmlImport.ts'
import { fromTabImage } from './editor/imageImport.ts'
import { useMidiInput } from './editor/useMidiInput.ts'
import { MAX_MEASURES, NOTE_VALUES, type NoteValue } from './editor/model.ts'
import { MAX_FRET, STRINGS } from './editor/tuning.ts'

export type Mode = 'open' | 'edit' | 'video'

/** Keys that pick a note value, by the first letter of its English name. */
const VALUE_KEYS: Record<string, NoteValue> = { w: 1, h: 2, q: 4, e: 8, s: 16 }

/** How long consecutive digits are treated as one fret number, e.g. 1 then 2. */
const FRET_KEY_WINDOW_MS = 800

export default function App() {
  const { containerRef, loadScore, status } = useOsmd()
  // The first thing on screen is the saved score, not an empty page waiting
  // for a file: the storage layer restores whatever was open last, so there
  // is always a score to show, and a returning user came back for theirs.
  const [mode, setMode] = useState<Mode>('edit')
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

  /**
   * Switching scores also ends the run of digits. The run remembers a position
   * in the score being left, and a digit typed just after a switch would
   * otherwise try to amend that position in the score that just opened.
   */
  const library = useMemo(
    () => ({
      select: (id: ScoreId) => {
        lastFret.current = null
        editor.selectScore(id)
      },
      add: () => {
        lastFret.current = null
        editor.addScore()
      },
      remove: (id: ScoreId) => {
        lastFret.current = null
        editor.deleteScore(id)
      },
    }),
    [editor],
  )

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
        // It only extends while the two digits together are a fret that exists:
        // "3" then "3" is not fret 33, and clamping it to the top fret both lost
        // the note that was there and swallowed the keystroke, so the second
        // digit starts the next note instead. A run already sitting on "0" is
        // the same case -- no fret is written "05" -- while an empty run is not,
        // since that is a click's note waiting for its first digit.
        const base = previous?.digits ?? ''
        if (previous && now - previous.time < FRET_KEY_WINDOW_MS) {
          const digits = base + key
          const fret = Number(digits)
          if (base !== '0' && fret <= MAX_FRET) {
            editor.setFretAt(previous.at, fret)
            lastFret.current = { at: previous.at, digits, time: now }
            return
          }
        }
        recordPlacement(editor.putNote(editor.stringNumber, Number(key)), key)
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
          if (event.shiftKey) editor.moveMeasure(-1)
          else editor.moveCursor(-1)
          break
        case 'ArrowRight':
          if (event.shiftKey) editor.moveMeasure(1)
          else editor.moveCursor(1)
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

  const [importNotice, setImportNotice] = useState<string | null>(null)

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

  /**
   * Takes either a whole library or a single MusicXML score. Both are read the
   * same way -- validate, then add -- so an unreadable file changes nothing and
   * says so instead of failing quietly.
   */
  const handleImportFile = useCallback(
    async (file: File) => {
      if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
        // OCR takes seconds (the engine alone is megabytes, loaded lazily),
        // so the wait has to say it is one.
        setImportNotice('画像を読み取っています…')
        const result = await fromTabImage(file, file.name.replace(/\.[^.]+$/, ''))
        if (!result.ok) {
          setImportNotice(
            result.reason === 'no-lanes'
              ? '4 本の弦の線が見つかりませんでした'
              : result.reason === 'chord'
                ? '同じ位置に複数の弦の数字があるので取り込めません（和音は持てないため）'
                : result.reason === 'no-notes'
                  ? '弦の線の上に数字が見つかりませんでした'
                  : result.reason === 'too-long'
                    ? `小節が多すぎて取り込めません（上限 ${MAX_MEASURES} 小節）`
                    : '画像を読めませんでした',
          )
          return
        }
        editor.importScores([result.score])
        setImportNotice(
          result.unread > 0
            ? `1 曲を取り込みました（${result.unread} 箇所読めず、休符にしてあります）`
            : '1 曲を取り込みました（全部 8 分音符なので、音価はエディタで直してください）',
        )
        return
      }

      const text = await file.text()
      if (file.name.endsWith('.json')) {
        const result = fromBackup(text)
        if (!result.ok) {
          setImportNotice(
            result.reason === 'wrong-format'
              ? 'この JSON は bass-tabs の書き出しではありません'
              : result.reason === 'wrong-version'
                ? '対応していない版の書き出しです'
                : result.reason === 'no-scores'
                  ? '読める譜面がありませんでした'
                  : 'ファイルを読めませんでした',
          )
          return
        }
        editor.importScores(result.scores)
        setImportNotice(`${result.scores.length} 曲を取り込みました`)
        return
      }

      const result = fromMusicXml(text)
      if (!result.ok) {
        setImportNotice(
          result.reason === 'no-tab'
            ? 'TAB 譜が入っていないので取り込めません（表示は「ファイルを開く」から）'
            : result.reason === 'unsupported'
              ? '和音・タイ・装飾音が入っているので取り込めません（表示は「ファイルを開く」から）'
              : result.reason === 'too-long'
                ? `小節が多すぎて取り込めません（上限 ${MAX_MEASURES} 小節）`
                : result.reason === 'overfull'
                  ? '拍子に収まらない小節があるので取り込めません'
                  : 'ファイルを読めませんでした',
        )
        return
      }
      editor.importScores([result.score])
      setImportNotice('1 曲を取り込みました')
    },
    [editor],
  )

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
            onSelect={library.select}
            onAdd={library.add}
            onDelete={library.remove}
            onExportAll={handleExportAll}
            onImportFile={(file) => {
              // A rejected promise here would leave the person with no file
              // imported and nothing said about it.
              handleImportFile(file).catch((error: unknown) => {
                setImportNotice(
                  `ファイルを読めませんでした: ${error instanceof Error ? error.message : String(error)}`,
                )
              })
            }}
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
          </div>
          )}
        </div>
      )}
      {/* The score stays mounted -- OSMD owns this container -- but in video
          mode it must not be visible: the capture films this same tab, and
          staff lines on screen read as false string lines. */}
      <ScoreView containerRef={containerRef} status={status} hidden={mode === 'video'} />
    </>
  )
}
