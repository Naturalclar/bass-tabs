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
import {
  newScoreId,
  readLibrary,
  removeScore,
  writeIndex,
  writeScore,
  type ScoreId,
  type StoredScore,
} from './storage.ts'
import { MAX_FRET, STRINGS, restring, transpose } from './tuning.ts'

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

/** A library that always holds at least one score, so there is always one open. */
function initialLibrary(): { scores: StoredScore[]; currentId: ScoreId } {
  const stored = readLibrary()
  if (stored.currentId && stored.scores.length > 0) {
    return { scores: stored.scores, currentId: stored.currentId }
  }
  const first = { id: newScoreId(), score: emptyScore() }
  return { scores: [first], currentId: first.id }
}

export function useEditor() {
  const [library, setLibrary] = useState(initialLibrary)
  const { scores, currentId } = library
  const score = scores.find((entry) => entry.id === currentId)?.score ?? emptyScore()
  const [cursor, setCursor] = useState<Cursor>({ measure: 0, index: 0 })
  const [value, setValue] = useState<NoteValue>(4)
  const [dotted, setDotted] = useState(false)
  const [fret, setFret] = useState(0)
  /** The string arrow keys move over and digit keys write to. */
  const [stringNumber, setStringNumber] = useState(STRINGS[STRINGS.length - 1].number)
  const setScore = useCallback(
    (next: Score) => {
      setLibrary((current) => ({
        ...current,
        scores: current.scores.map((entry) =>
          entry.id === current.currentId ? { ...entry, score: next } : entry,
        ),
      }))
    },
    [],
  )
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  /** The key of the last commit, for collapsing a run of edits into one step. */
  const lastKey = useRef<CommitKey>(null)

  // Only the score being edited is written on a keystroke. The index changes
  // when scores are added, removed or switched, so those write it themselves.
  useEffect(() => {
    writeScore(currentId, score)
  }, [currentId, score])

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
    [cursor, score, setScore],
  )

  /**
   * Writes `entry` at `at`, carrying on into later measures when it does not
   * fit there and growing the score when it runs off the end.
   *
   * `keyPrefix` is not the commit key itself: where the entry lands is only
   * known here, and the key has to name that slot so the fret digits that
   * follow amend the same undo step.
   */
  const place = useCallback(
    (entry: Entry, at: Cursor, keyPrefix: string | null = null): Cursor | null => {
      const measures = score.measures
      const keyFor = (slot: Cursor): CommitKey =>
        keyPrefix === null ? null : `${keyPrefix}:${slot.measure}:${slot.index}`
      const entries = measures[at.measure] ?? []
      const replacing = at.index < entries.length
      const written = replacing
        ? entries.map((existing, i) => (i === at.index ? entry : existing))
        : [...entries, entry]

      if (measureRemaining(written, score.time) >= 0) {
        commit(
          {
            ...score,
            measures: measures.map((existing, i) => (i === at.measure ? written : existing)),
          },
          { measure: at.measure, index: Math.min(at.index + 1, written.length) },
          keyFor(at),
        )
        return at
      }

      // It does not fit here. Typing straight through a score means a full bar
      // has to hand over to the next one rather than swallow the keystroke, so
      // the entry moves on to the first later measure with room for it. Two
      // things cannot move: rewriting a slot that already exists, and a value
      // longer than any bar of this time signature, which has nowhere to go.
      const alone = [entry]
      if (replacing || measureRemaining(alone, score.time) < 0) return null

      let target = at.measure + 1
      while (
        target < measures.length &&
        measureRemaining([...(measures[target] ?? []), entry], score.time) < 0
      ) {
        target += 1
      }
      // Past the last measure the score grows. Only a write does this -- moving
      // the cursor does not -- so the measure that appears always holds the note
      // that asked for it, and a score never ends with an empty bar nobody
      // wrote in.
      if (target >= MAX_MEASURES) return null
      const into = [...(measures[target] ?? []), entry]
      const slot = { measure: target, index: into.length - 1 }
      commit(
        {
          ...score,
          measures:
            target < measures.length
              ? measures.map((existing, i) => (i === target ? into : existing))
              : [...measures, into],
        },
        { measure: target, index: into.length },
        keyFor(slot),
      )
      return slot
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
      // Keyed on where it lands, so the fret digits that follow amend that step.
      return place({ kind: 'note', string: targetString, fret: clamped, value, dotted }, at, 'fret')
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

  /** Jumps a whole measure, landing on its first slot. */
  const moveMeasure = useCallback(
    (delta: number) => {
      lastKey.current = null
      setCursor((c) => {
        const measure = Math.min(Math.max(c.measure + delta, 0), score.measures.length - 1)
        return measure === c.measure ? c : { measure, index: 0 }
      })
    },
    [score.measures.length],
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

  /**
   * Moves to another score. The undo history stays behind: it describes edits
   * to the score being left, and replaying them onto a different one would put
   * this score's notes into that score.
   */
  const selectScore = useCallback(
    (id: ScoreId) => {
      if (id === currentId) return
      setLibrary((current) =>
        current.scores.some((entry) => entry.id === id) ? { ...current, currentId: id } : current,
      )
      writeIndex(
        scores.map((entry) => entry.id),
        id,
      )
      setCursor({ measure: 0, index: 0 })
      setPast([])
      setFuture([])
      lastKey.current = null
    },
    [currentId, scores],
  )

  /** Adds an empty score and opens it. The scores already saved stay put. */
  const addScore = useCallback(() => {
    const entry = { id: newScoreId(), score: emptyScore() }
    setLibrary((current) => ({
      scores: [...current.scores, entry],
      currentId: entry.id,
    }))
    writeScore(entry.id, entry.score)
    writeIndex([...scores.map((existing) => existing.id), entry.id], entry.id)
    setCursor({ measure: 0, index: 0 })
    setPast([])
    setFuture([])
    lastKey.current = null
  }, [scores])

  /**
   * Adds scores read from a file, and opens the first of them.
   *
   * They are always added, never merged over what is already saved: an import
   * is someone bringing scores in, and quietly replacing the ones they already
   * had would be the one mistake there is no undo for. New ids are minted so a
   * file restored twice cannot collide with itself.
   */
  const importScores = useCallback(
    (incoming: Score[]) => {
      if (incoming.length === 0) return
      const added = incoming.map((score) => ({ id: newScoreId(), score }))
      setLibrary((current) => ({
        scores: [...current.scores, ...added],
        currentId: added[0].id,
      }))
      for (const entry of added) writeScore(entry.id, entry.score)
      writeIndex(
        [...scores.map((entry) => entry.id), ...added.map((entry) => entry.id)],
        added[0].id,
      )
      setCursor({ measure: 0, index: 0 })
      setPast([])
      setFuture([])
      lastKey.current = null
    },
    [scores],
  )

  /**
   * Deletes a score for good -- undo cannot reach it, because the history
   * describes edits inside a score, not the library around it. The UI asks
   * first for that reason. Deleting the last one leaves a fresh empty score, so
   * there is always something open.
   */
  const deleteScore = useCallback(
    (id: ScoreId) => {
      const remaining = scores.filter((entry) => entry.id !== id)
      const next =
        remaining.length > 0 ? remaining : [{ id: newScoreId(), score: emptyScore() }]
      const nextId = remaining.some((entry) => entry.id === currentId)
        ? currentId
        : (next[0]?.id ?? '')
      setLibrary({ scores: next, currentId: nextId })
      removeScore(id)
      if (remaining.length === 0) writeScore(next[0].id, next[0].score)
      writeIndex(
        next.map((entry) => entry.id),
        nextId,
      )
      if (nextId !== currentId) {
        setCursor({ measure: 0, index: 0 })
        setPast([])
        setFuture([])
        lastKey.current = null
      }
    },
    [currentId, scores],
  )

  /**
   * The entry the arrow keys act on: the one under the cursor, or -- when the
   * cursor sits on the empty append slot, which is where it lands right after
   * writing -- the one just before it. Either way it is the column the grid is
   * highlighting, so the note that moves is the note that looks selected.
   */
  const targetIndex = useCallback((): number | null => {
    const entries = score.measures[cursor.measure] ?? []
    if (entries[cursor.index]) return cursor.index
    if (entries[cursor.index - 1]) return cursor.index - 1
    return null
  }, [cursor, score.measures])

  /**
   * Moves the selected note, either in pitch (`semitones`) or across strings at
   * the same pitch (`strings`). Rests have no pitch, and a move off the end of
   * the neck has nowhere to go: both leave the score alone.
   *
   * Repeated presses collapse into one undo step, keyed by position, so nudging
   * a note four semitones is one step back rather than four.
   */
  const moveNote = useCallback(
    ({ semitones = 0, strings = 0 }: { semitones?: number; strings?: number }) => {
      const index = targetIndex()
      if (index === null) return
      const entries = score.measures[cursor.measure] ?? []
      const entry = entries[index]
      if (entry.kind !== 'note') return
      const moved = semitones
        ? transpose({ string: entry.string, fret: entry.fret }, semitones)
        : restring({ string: entry.string, fret: entry.fret }, strings)
      if (!moved) return
      // The next note follows the string and fret this one ended on.
      setStringNumber(moved.string)
      setFret(moved.fret)
      commit(
        {
          ...score,
          measures: score.measures.map((measure, i) =>
            i !== cursor.measure
              ? measure
              : measure.map((existing, j) =>
                  j === index ? { ...entry, string: moved.string, fret: moved.fret } : existing,
                ),
          ),
        },
        cursor,
        `move:${cursor.measure}:${index}`,
      )
    },
    [commit, cursor, score, targetIndex],
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
    setDotted,
    fret,
    setFret,
    stringNumber,
    setStringNumber,
    remaining,
    putNote,
    moveNote,
    setFretAt,
    putRest,
    removeAtCursor,
    moveCursor,
    moveMeasure,
    setTime,
    setKeyFifths,
    setTitle,
    setMeasureCount,
    scores,
    currentId,
    selectScore,
    addScore,
    deleteScore,
    importScores,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  }
}
