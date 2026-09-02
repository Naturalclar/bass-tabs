import { useCallback, useEffect, useRef } from 'react'
import { NOTE_VALUES, type NoteValue } from './model.ts'
import { MAX_FRET, TUNINGS } from './tuning.ts'
import type { Cursor } from './edit.ts'
import type { useEditor } from './useEditor.ts'

type Editor = ReturnType<typeof useEditor>

/** Keys that pick a note value, by the first letter of its English name. */
const VALUE_KEYS: Record<string, NoteValue> = { w: 1, h: 2, q: 4, e: 8, s: 16 }

/**
 * The slice of a keyboard event the scheme reads. React's synthetic event and
 * the window's native one both fit, so the same handler serves the editor div
 * and the window-level fallback in App -- the fallback exists because the
 * transport buttons sit outside `.tab-editor` and keep focus after a click.
 */
export type EditorKeyEvent = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  preventDefault(): void
}

/** How long consecutive digits are treated as one fret number, e.g. 1 then 2. */
const FRET_KEY_WINDOW_MS = 800

/**
 * The tab editor's keyboard scheme, and with it the run of digits: the note
 * the last placement wrote -- its slot and, since a beat can be a chord,
 * which string of it -- so a following digit edits that note rather than
 * starting a new one after it.
 *
 * The run remembers a position in the open score, so it clears on the same
 * seam the editor's own position state does: when `currentId` changes. Any
 * way the open score can change -- switch, add, delete, import -- is covered
 * without each call site remembering to (importing never did, back when App
 * cleared it by hand). Undo and redo also end the run, via the wrappers
 * here, because the slot it was amending may not exist after a jump through
 * history.
 */
export function useEditorKeyboard(editor: Editor) {
  const lastFret = useRef<{ at: Cursor; string: number; digits: string | null; time: number } | null>(
    null,
  )

  useEffect(() => {
    lastFret.current = null
  }, [editor.currentId])

  /**
   * `digits` is what a further digit appends to, and is null after a click:
   * a click carries over the previous fret, so appending to it would read the
   * first digit typed as a second digit of a number nobody entered.
   */
  const record = useCallback(
    (placed: { at: Cursor; string: number } | null, digits: string | null) => {
      lastFret.current = placed ? { ...placed, digits, time: Date.now() } : null
    },
    [],
  )

  /** The click's entry into the run: place (or toggle) first, then remember it. */
  const clickLane = useCallback(
    (at: Cursor, stringNumber: number) => {
      record(editor.toggleNoteAt(at, stringNumber), null)
    },
    [editor, record],
  )

  const undo = useCallback(() => {
    lastFret.current = null
    editor.undo()
  }, [editor])

  const redo = useCallback(() => {
    lastFret.current = null
    editor.redo()
  }, [editor])

  const handleKeyDown = useCallback(
    (event: EditorKeyEvent) => {
      const key = event.key
      // Ctrl/Cmd combinations belong to the window-level undo handler. Shift
      // is not one of them: it selects the string variant of the arrow keys.
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
            editor.setFretAt(previous.at, previous.string, fret)
            lastFret.current = { ...previous, digits, time: now }
            return
          }
        }
        record(editor.putNote(editor.stringNumber, Number(key)), key)
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
          // `<string>` numbers count down from the highest-pitched string, and
          // how far down depends on the score's own tuning.
          {
            const strings = TUNINGS[editor.score.tuning]
            editor.setStringNumber(
              towardsHigherPitch
                ? Math.max(strings[0].number, editor.stringNumber - 1)
                : Math.min(strings[strings.length - 1].number, editor.stringNumber + 1),
            )
          }
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
        // Not a digit: those are frets, so a triplet cannot be "3".
        case 't':
        case 'T':
          editor.setTriplet(!editor.triplet)
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
    [editor, record],
  )

  return { handleKeyDown, clickLane, undo, redo }
}
