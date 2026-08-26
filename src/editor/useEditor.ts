import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  emptyScore,
  fits,
  measureRemaining,
  type Entry,
  type NoteValue,
  type Score,
  type TimeSignature,
} from './model.ts'
import { toMusicXml } from './musicxml.ts'
import { MAX_FRET, STRINGS } from './tuning.ts'

const STORAGE_KEY = 'bass-tabs:score'

/** Where the next entry goes: which measure, and how far into it. */
export type Cursor = { measure: number; index: number }

export type EditorState = {
  score: Score
  cursor: Cursor
  value: NoteValue
  dotted: boolean
  /** The fret a click on a string lane places, and what digit keys edit. */
  fret: number
}

function load(): Score {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyScore()
    const parsed: unknown = JSON.parse(raw)
    // Nothing validates what is in storage, and a half-written score would
    // otherwise crash on the first render, so fall back on any surprise.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Score).measures) &&
      typeof (parsed as Score).title === 'string'
    ) {
      return parsed as Score
    }
  } catch {
    // Storage can throw outright in a private window; an empty score is fine.
  }
  return emptyScore()
}

export function useEditor() {
  const [score, setScore] = useState<Score>(load)
  const [cursor, setCursor] = useState<Cursor>({ measure: 0, index: 0 })
  const [value, setValue] = useState<NoteValue>(4)
  const [dotted, setDotted] = useState(false)
  const [fret, setFret] = useState(0)
  /** The string arrow keys move over and digit keys write to. */
  const [stringNumber, setStringNumber] = useState(STRINGS[STRINGS.length - 1].number)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(score))
    } catch {
      // Out of quota or storage blocked: losing persistence is not worth
      // interrupting the person mid-edit.
    }
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
  const place = useCallback(
    (entry: Entry, at: Cursor): Cursor | null => {
      const entries = score.measures[at.measure] ?? []
      const replacing = at.index < entries.length
      const next = replacing
        ? entries.map((existing, i) => (i === at.index ? entry : existing))
        : [...entries, entry]
      if (measureRemaining(next, score.time) < 0) return null
      setScore((current) => ({
        ...current,
        measures: current.measures.map((existing, i) => (i === at.measure ? next : existing)),
      }))
      setCursor({ measure: at.measure, index: Math.min(at.index + 1, next.length) })
      return at
    },
    [score],
  )

  const putNote = useCallback(
    (targetString: number, atFret: number, at: Cursor = cursor) => {
      const clamped = Math.min(Math.max(atFret, 0), MAX_FRET)
      // Placing also moves the keyboard's idea of where it is, so clicking a
      // lane and then typing a fret keeps working on that same string.
      setFret(clamped)
      setStringNumber(targetString)
      return place({ kind: 'note', string: targetString, fret: clamped, value, dotted }, at)
    },
    [cursor, dotted, place, value],
  )

  /**
   * Rewrites the fret of an entry already on the staff, leaving the cursor
   * alone. Typing a second digit has to edit the note the first digit made,
   * not write a new one after it.
   */
  const setFretAt = useCallback((at: Cursor, atFret: number) => {
    const clamped = Math.min(Math.max(atFret, 0), MAX_FRET)
    setFret(clamped)
    setScore((current) => ({
      ...current,
      measures: current.measures.map((entries, i) =>
        i !== at.measure
          ? entries
          : entries.map((entry, j) =>
              j === at.index && entry.kind === 'note' ? { ...entry, fret: clamped } : entry,
            ),
      ),
    }))
  }, [])

  const putRest = useCallback(
    (at: Cursor = cursor) => {
      place({ kind: 'rest', value, dotted }, at)
    },
    [cursor, dotted, place, value],
  )

  const removeAtCursor = useCallback(() => {
    setScore((current) => ({
      ...current,
      measures: current.measures.map((entries, i) => {
        if (i !== cursor.measure) return entries
        const target = Math.min(cursor.index, entries.length - 1)
        return entries.filter((_, j) => j !== target)
      }),
    }))
    setCursor((c) => ({ ...c, index: Math.max(0, c.index - 1) }))
  }, [cursor])

  const moveCursor = useCallback(
    (delta: number) => {
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

  const setTime = useCallback((time: TimeSignature) => {
    // Existing entries can overflow a shorter bar; trim rather than silently
    // writing a measure that does not add up.
    setScore((current) => ({
      ...current,
      time,
      measures: current.measures.map((entries) => {
        const kept: Entry[] = []
        for (const entry of entries) {
          if (!fits(kept, time, entry.value, entry.dotted)) break
          kept.push(entry)
        }
        return kept
      }),
    }))
  }, [])

  const setKeyFifths = useCallback((keyFifths: number) => {
    setScore((current) => ({ ...current, keyFifths }))
  }, [])

  const setTitle = useCallback((title: string) => {
    setScore((current) => ({ ...current, title }))
  }, [])

  const setMeasureCount = useCallback((count: number) => {
    const clamped = Math.min(Math.max(count, 1), 64)
    setScore((current) => ({
      ...current,
      measures:
        clamped <= current.measures.length
          ? current.measures.slice(0, clamped)
          : [
              ...current.measures,
              ...Array.from({ length: clamped - current.measures.length }, (): Entry[] => []),
            ],
    }))
    setCursor((c) => ({ measure: Math.min(c.measure, clamped - 1), index: c.index }))
  }, [])

  const reset = useCallback(() => {
    setScore(emptyScore())
    setCursor({ measure: 0, index: 0 })
  }, [])

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
  }
}
