import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_MEASURES,
  emptyScore,
  fits,
  measureRemaining,
  type Entry,
  type NoteValue,
  type Score,
  type TimeSignature,
} from './model.ts'
import { toMusicXml } from './musicxml.ts'
import { readStoredScore, writeStoredScore } from './storage.ts'
import { MAX_FRET, STRINGS } from './tuning.ts'

/** Where the next entry goes: which measure, and how far into it. */
export type Cursor = { measure: number; index: number }

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

export type EditorState = {
  score: Score
  cursor: Cursor
  value: NoteValue
  dotted: boolean
  /** The fret a click on a string lane places, and what digit keys edit. */
  fret: number
}

export function useEditor() {
  const [score, setScore] = useState<Score>(() => readStoredScore() ?? emptyScore())
  const [cursor, setCursor] = useState<Cursor>({ measure: 0, index: 0 })
  const [value, setValue] = useState<NoteValue>(4)
  const [dotted, setDotted] = useState(false)
  const [fret, setFret] = useState(0)
  /** The string arrow keys move over and digit keys write to. */
  const [stringNumber, setStringNumber] = useState(STRINGS[STRINGS.length - 1].number)
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  /** The key of the last commit, for collapsing a run of edits into one step. */
  const lastKey = useRef<CommitKey>(null)

  useEffect(() => {
    writeStoredScore(score)
  }, [score])

  const musicXml = useMemo(() => toMusicXml(score), [score])

  /**
   * Writes one entry at `at`: replacing the entry under it, or appending when
   * it sits past the end. Whether the write happened decides whether the cursor
   * advances -- advancing after a rejected append would leave the cursor
   * pointing into a gap past the end of the measure.
   *
   * The target is an argument rather than the current cursor because a click
   * knows where it landed. Moving the cursor first and placing afterwards
   * cannot work: both happen in one handler, so the place would still read the
   * pre-click cursor out of its closure and write to the wrong slot.
   *
   * The measure is measured after the write, not before: a replacement changes
   * the length of an entry that is already counted, so asking whether the new
   * entry "fits in what is left" is the wrong question for it. Building the
   * result first and rejecting an overfull measure asks the same question of
   * both paths.
   */
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
    [cursor, score],
  )

  const place = useCallback(
    (entry: Entry, at: Cursor, key: CommitKey = null): Cursor | null => {
      const entries = score.measures[at.measure] ?? []
      const replacing = at.index < entries.length
      const next = replacing
        ? entries.map((existing, i) => (i === at.index ? entry : existing))
        : [...entries, entry]
      if (measureRemaining(next, score.time) < 0) return null
      commit(
        {
          ...score,
          measures: score.measures.map((existing, i) => (i === at.measure ? next : existing)),
        },
        { measure: at.measure, index: Math.min(at.index + 1, next.length) },
        key,
      )
      return at
    },
    [commit, score],
  )

  const putNote = useCallback(
    (targetString: number, atFret: number, at: Cursor = cursor) => {
      const clamped = Math.min(Math.max(atFret, 0), MAX_FRET)
      // Placing also moves the keyboard's idea of where it is, so clicking a
      // lane and then typing a fret keeps working on that same string.
      setFret(clamped)
      setStringNumber(targetString)
      // Keyed by position: the fret digits that follow amend this same step.
      return place(
        { kind: 'note', string: targetString, fret: clamped, value, dotted },
        at,
        `fret:${at.measure}:${at.index}`,
      )
    },
    [cursor, dotted, place, value],
  )

  /**
   * Rewrites the fret of an entry already on the staff, leaving the cursor
   * alone. Typing a second digit has to edit the note the first digit made,
   * not write a new one after it.
   */
  const setFretAt = useCallback(
    (at: Cursor, atFret: number) => {
      const clamped = Math.min(Math.max(atFret, 0), MAX_FRET)
      setFret(clamped)
      commit(
        {
          ...score,
          measures: score.measures.map((entries, i) =>
            i !== at.measure
              ? entries
              : entries.map((entry, j) =>
                  j === at.index && entry.kind === 'note' ? { ...entry, fret: clamped } : entry,
                ),
          ),
        },
        cursor,
        // Same key the placement used, so the whole run is one undo.
        `fret:${at.measure}:${at.index}`,
      )
    },
    [commit, cursor, score],
  )

  const putRest = useCallback(
    (at: Cursor = cursor) => {
      place({ kind: 'rest', value, dotted }, at)
    },
    [cursor, dotted, place, value],
  )

  const removeAtCursor = useCallback(() => {
    commit(
      {
        ...score,
        measures: score.measures.map((entries, i) => {
          if (i !== cursor.measure) return entries
          const target = Math.min(cursor.index, entries.length - 1)
          return entries.filter((_, j) => j !== target)
        }),
      },
      { ...cursor, index: Math.max(0, cursor.index - 1) },
    )
  }, [commit, cursor, score])

  const moveCursor = useCallback(
    (delta: number) => {
      // Moving is not an edit, so it neither records history nor ends a run --
      // but it does end one: the next digit should start a new fret, not extend
      // the one left behind.
      lastKey.current = null
      setCursor((c) => {
        const entries = score.measures[c.measure] ?? []
        const next = c.index + delta
        if (next < 0) {
          if (c.measure === 0) return c
          const previous = score.measures[c.measure - 1] ?? []
          return { measure: c.measure - 1, index: previous.length }
        }
        if (next > entries.length) {
          if (c.measure >= score.measures.length - 1) return c
          return { measure: c.measure + 1, index: 0 }
        }
        return { ...c, index: next }
      })
    },
    [score.measures],
  )

  const setTime = useCallback(
    (time: TimeSignature) => {
      // Existing entries can overflow a shorter bar; trim rather than silently
      // writing a measure that does not add up.
      commit(
        {
          ...score,
          time,
          measures: score.measures.map((entries) => {
            const kept: Entry[] = []
            for (const entry of entries) {
              if (!fits(kept, time, entry.value, entry.dotted)) break
              kept.push(entry)
            }
            return kept
          }),
        },
        cursor,
      )
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
      const clamped = Math.min(Math.max(count, 1), MAX_MEASURES)
      commit(
        {
          ...score,
          measures:
            clamped <= score.measures.length
              ? score.measures.slice(0, clamped)
              : [
                  ...score.measures,
                  ...Array.from({ length: clamped - score.measures.length }, (): Entry[] => []),
                ],
        },
        { measure: Math.min(cursor.measure, clamped - 1), index: cursor.index },
      )
    },
    [commit, cursor, score],
  )

  const reset = useCallback(() => {
    // Undoable on purpose: 新規 throws away everything, and mis-clicking it is
    // exactly the situation undo exists for.
    commit(emptyScore(), { measure: 0, index: 0 })
  }, [commit])

  const undo = useCallback(() => {
    const previous = past.at(-1)
    if (!previous) return
    setPast((entries) => entries.slice(0, -1))
    setFuture((entries) => [...entries, { score, cursor }])
    setScore(previous.score)
    setCursor(previous.cursor)
    lastKey.current = null
  }, [cursor, past, score])

  const redo = useCallback(() => {
    const next = future.at(-1)
    if (!next) return
    setFuture((entries) => entries.slice(0, -1))
    setPast((entries) => [...entries, { score, cursor }].slice(-MAX_HISTORY))
    setScore(next.score)
    setCursor(next.cursor)
    lastKey.current = null
  }, [cursor, future, score])

  const remaining = measureRemaining(score.measures[cursor.measure] ?? [], score.time)

  return {
    score,
    musicXml,
    cursor,
    value,
    setValue,
    dotted,
    setDotted,
    fret,
    setFret,
    stringNumber,
    setStringNumber,
    remaining,
    putNote,
    setFretAt,
    putRest,
    removeAtCursor,
    moveCursor,
    setTime,
    setKeyFifths,
    setTitle,
    setMeasureCount,
    reset,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  }
}
