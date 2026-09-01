import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clampTempo,
  measureRemaining,
  type Entry,
  type NoteValue,
  type Score,
  type TimeSignature,
} from './model.ts'
import { toMusicXml } from './musicxml.ts'
import { MAX_FRET, STRINGS } from './tuning.ts'
import { useLibrary } from './useLibrary.ts'
import * as edit from './edit.ts'
import type { Cursor } from './edit.ts'

export type { Cursor } from './edit.ts'

/**
 * What undo restores. The cursor travels with the score: putting the notes back
 * but leaving the cursor wherever it drifted to would send the next keystroke
 * somewhere the person is not looking.
 */
type Snapshot = { score: Score; cursor: Cursor }

/** How many steps back you can go. Deep enough to undo a wrong turn, not a session. */
const MAX_HISTORY = 50

/**
 * Names a run of edits that undo should treat as one step. Consecutive commits
 * carrying the same key collapse into the first: typing a title is one undo,
 * not one per letter, and "1" then "2" for the 12th fret is one undo, not two.
 */
export type CommitKey = string | null

/**
 * Editing the open score. The score transformations themselves are the pure
 * functions in edit.ts; this hook holds what they cannot -- which score is
 * open (via useLibrary), where the cursor stands, the undo history -- and
 * feeds their results through `commit()`.
 */
export function useEditor() {
  const library = useLibrary()
  const { score, currentId, setScore } = library
  const [cursor, setCursor] = useState<Cursor>({ measure: 0, index: 0 })
  const [value, setValue] = useState<NoteValue>(4)
  const [dotted, setDottedState] = useState(false)
  const [triplet, setTripletState] = useState(false)
  // Exclusive: a dotted triplet is not something anyone writes here, and
  // `ticks` would have to pick one of the two anyway. Turning either on
  // turns the other off, so the pair can never disagree with the duration.
  const setDotted = useCallback((next: boolean) => {
    setDottedState(next)
    if (next) setTripletState(false)
  }, [])
  const setTriplet = useCallback((next: boolean) => {
    setTripletState(next)
    if (next) setDottedState(false)
  }, [])
  const [fret, setFret] = useState(0)
  /** The string arrow keys move over and digit keys write to. */
  const [stringNumber, setStringNumber] = useState(STRINGS[STRINGS.length - 1].number)
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  /** The key of the last commit, for collapsing a run of edits into one step. */
  const lastKey = useRef<CommitKey>(null)

  /**
   * The one seam between the library and the editing state. Everything above
   * remembers a position in the open score, so when the open score changes --
   * a switch, an add, an import, a delete of the open one -- all of it resets
   * here, and only here. The library's operations carry no resets of their
   * own, so a new one cannot forget to; and adjusting during render rather
   * than in an effect keeps a cursor from another score from ever reaching
   * the DOM.
   */
  const [editingId, setEditingId] = useState(currentId)
  if (editingId !== currentId) {
    setEditingId(currentId)
    setCursor({ measure: 0, index: 0 })
    setPast([])
    setFuture([])
  }
  // The ref part of the same reset. A ref must not be written during render,
  // and an effect is early enough: it runs before any event that could
  // commit against the stale key.
  useEffect(() => {
    lastKey.current = null
  }, [currentId])

  const musicXml = useMemo(() => toMusicXml(score), [score])

  /**
   * The one place the score changes. Everything else describes the next score
   * and hands it here, so history has a single choke point rather than eight.
   *
   * Passing the same `key` as the previous commit extends that step instead of
   * adding one, which is how a run of keystrokes stays a single undo.
   */
  const commit = useCallback(
    (next: Score, nextCursor: Cursor, key: CommitKey = null) => {
      const continuing = key !== null && key === lastKey.current
      if (!continuing) {
        setPast((entries) => [...entries, { score, cursor }].slice(-MAX_HISTORY))
      }
      lastKey.current = key
      // A new edit is a new branch: whatever was undone is no longer reachable.
      setFuture([])
      setScore(next)
      setCursor(nextCursor)
    },
    [cursor, score, setScore],
  )

  /**
   * Commits a placement, keyed on the slot it landed in -- which only the
   * placement itself knows -- so the fret digits that follow amend that step.
   *
   * The target is an argument rather than the current cursor because a click
   * knows where it landed. Moving the cursor first and placing afterwards
   * cannot work: both happen in one handler, so the place would still read the
   * pre-click cursor out of its closure and write to the wrong slot.
   */
  const place = useCallback(
    (entry: Entry, at: Cursor, keyPrefix: string | null = null): Cursor | null => {
      const placed = edit.place(score, entry, at)
      if (!placed) return null
      commit(
        placed.score,
        placed.cursor,
        keyPrefix === null ? null : `${keyPrefix}:${placed.slot.measure}:${placed.slot.index}`,
      )
      return placed.slot
    },
    [commit, score],
  )

  /**
   * Writes a single note (replacing whatever the slot held) -- the keyboard's
   * and MIDI's entry point. Chords are built by clicking, via `toggleNoteAt`.
   */
  const putNote = useCallback(
    (targetString: number, atFret: number, at: Cursor = cursor) => {
      const clamped = Math.min(Math.max(atFret, 0), MAX_FRET)
      // Placing also moves the keyboard's idea of where it is, so clicking a
      // lane and then typing a fret keeps working on that same string.
      setFret(clamped)
      setStringNumber(targetString)
      const slot = place(
        { kind: 'note', notes: [{ string: targetString, fret: clamped }], value, dotted, triplet },
        at,
        'fret',
      )
      return slot === null ? null : { at: slot, string: targetString }
    },
    [cursor, dotted, place, triplet, value],
  )

  /**
   * The click's entry point: toggles a string in or out of an existing column,
   * or -- past the written columns -- writes a fresh note, same as the
   * keyboard.
   */
  const toggleNoteAt = useCallback(
    (at: Cursor, targetString: number): { at: Cursor; string: number } | null => {
      const toggled = edit.toggleString(score, at, targetString, fret)
      if (!toggled) return putNote(targetString, fret, at)
      if (toggled.added) setStringNumber(targetString)
      commit(toggled.score, toggled.cursor)
      // Only an added note wants the fret digits that follow; a removal has
      // nothing for them to amend.
      return toggled.added ? { at, string: targetString } : null
    },
    [commit, fret, putNote, score],
  )

  /** Rewrites the fret of a note already on the staff, leaving the cursor alone. */
  const setFretAt = useCallback(
    (at: Cursor, targetString: number, atFret: number) => {
      const clamped = Math.min(Math.max(atFret, 0), MAX_FRET)
      setFret(clamped)
      // Same key the placement used, so the whole run is one undo.
      commit(edit.withFret(score, at, targetString, clamped), cursor, `fret:${at.measure}:${at.index}`)
    },
    [commit, cursor, score],
  )

  /**
   * Appends a run of entries after everything already written -- what a
   * video-mode capture needs: each capture is one commit, so one Ctrl+Z takes
   * back one capture.
   */
  const appendEntries = useCallback(
    (entries: Entry[]): { added: number; dropped: number } => {
      const appended = edit.appendRun(score, entries)
      if (appended.added > 0) commit(appended.score, appended.cursor)
      return { added: appended.added, dropped: appended.dropped }
    },
    [commit, score],
  )

  const putRest = useCallback(
    (at: Cursor = cursor) => {
      place({ kind: 'rest', value, dotted, triplet }, at)
    },
    [cursor, dotted, place, triplet, value],
  )

  const removeAtCursor = useCallback(() => {
    const removed = edit.removeAt(score, cursor)
    commit(removed.score, removed.cursor)
  }, [commit, cursor, score])

  const moveCursor = useCallback(
    (delta: number) => {
      // Moving is not an edit, so it neither records history nor ends a run --
      // but it does end one: the next digit should start a new fret, not extend
      // the one left behind.
      lastKey.current = null
      setCursor((c) => edit.stepCursor(score, c, delta))
    },
    [score],
  )

  const moveMeasure = useCallback(
    (delta: number) => {
      lastKey.current = null
      setCursor((c) => edit.jumpMeasure(score, c, delta))
    },
    [score],
  )

  const setTime = useCallback(
    (time: TimeSignature) => {
      commit(edit.withTime(score, time), cursor)
    },
    [commit, cursor, score],
  )

  /**
   * Tempo is part of the score -- printed on the page, written to the file --
   * so a change goes through commit() and is undoable. One key for the whole
   * adjustment: nudging 100 to 160 is one step back, not sixty.
   */
  const setTempo = useCallback(
    (tempo: number) => {
      commit({ ...score, tempo: clampTempo(Math.round(tempo)) }, cursor, 'tempo')
    },
    [commit, cursor, score],
  )

  const setKeyFifths = useCallback(
    (keyFifths: number) => {
      commit({ ...score, keyFifths }, cursor)
    },
    [commit, cursor, score],
  )

  const setTitle = useCallback(
    (title: string) => {
      // One key for the whole field, so typing a name is a single undo.
      commit({ ...score, title }, cursor, 'title')
    },
    [commit, cursor, score],
  )

  const setMeasureCount = useCallback(
    (count: number) => {
      const resized = edit.withMeasureCount(score, cursor, count)
      commit(resized.score, resized.cursor)
    },
    [commit, cursor, score],
  )

  /**
   * Moves the selected beat in pitch or across strings. Repeated presses
   * collapse into one undo step, keyed by position, so nudging a note four
   * semitones is one step back rather than four.
   */
  const moveNote = useCallback(
    (move: { semitones?: number; strings?: number }) => {
      const moved = edit.moveBeat(score, cursor, move)
      if (!moved) return
      // The next note follows the string and fret this beat ended on.
      setStringNumber(moved.landed[0].string)
      setFret(moved.landed[0].fret)
      commit(moved.score, cursor, `move:${cursor.measure}:${moved.index}`)
    },
    [commit, cursor, score],
  )

  const undo = useCallback(() => {
    const previous = past.at(-1)
    if (!previous) return
    setPast((entries) => entries.slice(0, -1))
    setFuture((entries) => [...entries, { score, cursor }])
    setScore(previous.score)
    setCursor(previous.cursor)
    lastKey.current = null
  }, [cursor, past, score, setScore])

  const redo = useCallback(() => {
    const next = future.at(-1)
    if (!next) return
    setFuture((entries) => entries.slice(0, -1))
    setPast((entries) => [...entries, { score, cursor }].slice(-MAX_HISTORY))
    setScore(next.score)
    setCursor(next.cursor)
    lastKey.current = null
  }, [cursor, future, score, setScore])

  const remaining = measureRemaining(score.measures[cursor.measure] ?? [], score.time)

  return {
    score,
    musicXml,
    cursor,
    value,
    setValue,
    dotted,
    triplet,
    setDotted,
    setTriplet,
    fret,
    setFret,
    stringNumber,
    setStringNumber,
    remaining,
    putNote,
    moveNote,
    setFretAt,
    putRest,
    toggleNoteAt,
    appendEntries,
    removeAtCursor,
    moveCursor,
    moveMeasure,
    setTime,
    setKeyFifths,
    setTempo,
    setTitle,
    setMeasureCount,
    scores: library.scores,
    currentId,
    selectScore: library.selectScore,
    addScore: library.addScore,
    deleteScore: library.deleteScore,
    importScores: library.importScores,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  }
}
