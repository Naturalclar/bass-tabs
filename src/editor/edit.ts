/**
 * Pure transformations of a `Score` -- the "what changes" half of editing,
 * kept apart from the "when it commits" half in useEditor. Nothing here
 * touches React, storage or history: every function maps a score (and a
 * position in it) to the next score, so this file is testable the same way
 * playback's `schedule()` is -- directly, without a browser.
 *
 * Returning null always means "this edit has nowhere to go": the caller
 * decides what that feels like (usually: the score stays as it is).
 */

import {
  MAX_MEASURES,
  fits,
  measureRemaining,
  sortedFingerings,
  type Entry,
  type Fingering,
  type Score,
  type TimeSignature,
} from './model.ts'
import { restring, transpose } from './tuning.ts'

/** Where the next entry goes: which measure, and how far into it. */
export type Cursor = { measure: number; index: number }

/** A transformed score, with where the cursor should stand in it. */
export type Edit = { score: Score; cursor: Cursor }

function entriesAt(score: Score, measure: number): Entry[] {
  return score.measures[measure] ?? []
}

function withMeasure(score: Score, measure: number, entries: Entry[]): Score {
  return {
    ...score,
    measures: score.measures.map((existing, i) => (i === measure ? entries : existing)),
  }
}

function withEntry(score: Score, at: Cursor, next: (entry: Entry) => Entry): Score {
  return withMeasure(
    score,
    at.measure,
    entriesAt(score, at.measure).map((entry, i) => (i === at.index ? next(entry) : entry)),
  )
}

/**
 * Writes one entry at `at`: replacing the entry under it, or appending when
 * it sits past the end -- carrying on into later measures when it does not
 * fit there, and growing the score when it runs off the end. Null means the
 * write had nowhere to go, and the cursor must not advance either, or it
 * would point into a gap past the end of the measure.
 *
 * The measure is measured after the write, not before: a replacement changes
 * the length of an entry that is already counted, so asking whether the new
 * entry "fits in what is left" is the wrong question for it. Building the
 * result first and rejecting an overfull measure asks the same question of
 * both paths.
 *
 * `slot` is where the entry actually landed, which only this function knows;
 * the caller keys its undo step on it so the fret digits that follow amend
 * that same step.
 */
export function place(score: Score, entry: Entry, at: Cursor): (Edit & { slot: Cursor }) | null {
  const entries = entriesAt(score, at.measure)
  const replacing = at.index < entries.length
  const written = replacing
    ? entries.map((existing, i) => (i === at.index ? entry : existing))
    : [...entries, entry]

  if (measureRemaining(written, score.time) >= 0) {
    return {
      score: withMeasure(score, at.measure, written),
      cursor: { measure: at.measure, index: Math.min(at.index + 1, written.length) },
      slot: at,
    }
  }

  // It does not fit here. Typing straight through a score means a full bar
  // has to hand over to the next one rather than swallow the keystroke, so
  // the entry moves on to the first later measure with room for it. Two
  // things cannot move: rewriting a slot that already exists, and a value
  // longer than any bar of this time signature, which has nowhere to go.
  if (replacing || measureRemaining([entry], score.time) < 0) return null

  let target = at.measure + 1
  while (
    target < score.measures.length &&
    measureRemaining([...entriesAt(score, target), entry], score.time) < 0
  ) {
    target += 1
  }
  // Past the last measure the score grows. Only a write does this -- moving
  // the cursor does not -- so the measure that appears always holds the note
  // that asked for it, and a score never ends with an empty bar nobody
  // wrote in.
  if (target >= MAX_MEASURES) return null
  const into = [...entriesAt(score, target), entry]
  return {
    score:
      target < score.measures.length
        ? withMeasure(score, target, into)
        : { ...score, measures: [...score.measures, into] },
    cursor: { measure: target, index: into.length },
    slot: { measure: target, index: into.length - 1 },
  }
}

/**
 * Toggles one string in or out of the beat at `at` -- how a chord is built
 * (click the second string of the same column) and how one note of it is
 * taken out again. Taking out the last one leaves a rest, not a hole: the
 * beat was played empty, it did not stop existing, and the rhythm around it
 * must not shift.
 *
 * Null means there is no written beat at `at` to toggle; the caller places a
 * fresh note instead, same as the keyboard would.
 */
export function toggleString(
  score: Score,
  at: Cursor,
  targetString: number,
  fret: number,
): (Edit & { added: boolean }) | null {
  const entry = entriesAt(score, at.measure)[at.index]
  if (!entry || entry.kind === 'rest') return null

  const existing = entry.notes.find((note) => note.string === targetString)
  const notes = existing
    ? entry.notes.filter((note) => note.string !== targetString)
    : sortedFingerings([...entry.notes, { string: targetString, fret }])
  const next: Entry =
    notes.length > 0 ? { ...entry, notes } : { kind: 'rest', value: entry.value, dotted: entry.dotted }
  return { score: withEntry(score, at, () => next), cursor: at, added: !existing }
}

/**
 * Rewrites the fret of one string of a beat already on the staff, leaving
 * everything else alone -- typing a second digit has to edit the note the
 * first digit made, not write a new one after it.
 */
export function withFret(score: Score, at: Cursor, targetString: number, fret: number): Score {
  return withEntry(score, at, (entry) =>
    entry.kind === 'note'
      ? {
          ...entry,
          notes: entry.notes.map((note) =>
            note.string === targetString ? { ...note, fret } : note,
          ),
        }
      : entry,
  )
}

/**
 * Appends a run of entries after everything already written, filling the
 * last used measure and growing from there -- what a video-mode capture
 * needs. Entries past MAX_MEASURES are dropped and counted rather than
 * failing the whole batch: half a capture on the paper beats none at the
 * very end of a long score.
 *
 * With `added` 0 the returned score must not be committed: the trailing
 * empty measures were popped as the append point, and an append that added
 * nothing has no business taking them with it.
 */
export function appendRun(
  score: Score,
  entries: Entry[],
): Edit & { added: number; dropped: number } {
  const measures = score.measures.map((measure) => [...measure])
  // Trailing empty measures are the append point, not content to keep
  // after: writing into bar 1 of an untouched score should not leave 3
  // empty bars in front of the next capture.
  while (measures.length > 1 && measures[measures.length - 1].length === 0) measures.pop()
  let added = 0
  for (const entry of entries) {
    const last = measures[measures.length - 1]
    if (measureRemaining([...last, entry], score.time) >= 0) last.push(entry)
    else if (measures.length < MAX_MEASURES) measures.push([entry])
    else break
    added++
  }
  return {
    score: { ...score, measures },
    cursor: { measure: measures.length - 1, index: measures[measures.length - 1].length },
    added,
    dropped: entries.length - added,
  }
}

/** Removes the entry under the cursor -- or the last one, past the end. */
export function removeAt(score: Score, cursor: Cursor): Edit {
  const entries = entriesAt(score, cursor.measure)
  const target = Math.min(cursor.index, entries.length - 1)
  return {
    score: withMeasure(
      score,
      cursor.measure,
      entries.filter((_, j) => j !== target),
    ),
    cursor: { ...cursor, index: Math.max(0, cursor.index - 1) },
  }
}

/** One slot left or right, crossing barlines but stopping at either end. */
export function stepCursor(score: Score, cursor: Cursor, delta: number): Cursor {
  const entries = entriesAt(score, cursor.measure)
  const next = cursor.index + delta
  if (next < 0) {
    if (cursor.measure === 0) return cursor
    return { measure: cursor.measure - 1, index: entriesAt(score, cursor.measure - 1).length }
  }
  if (next > entries.length) {
    if (cursor.measure >= score.measures.length - 1) return cursor
    return { measure: cursor.measure + 1, index: 0 }
  }
  return { ...cursor, index: next }
}

/** Jumps a whole measure, landing on its first slot. */
export function jumpMeasure(score: Score, cursor: Cursor, delta: number): Cursor {
  const measure = Math.min(Math.max(cursor.measure + delta, 0), score.measures.length - 1)
  return measure === cursor.measure ? cursor : { measure, index: 0 }
}

/**
 * Changes the meter. Existing entries can overflow a shorter bar; trim
 * rather than silently writing a measure that does not add up.
 */
export function withTime(score: Score, time: TimeSignature): Score {
  return {
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
  }
}

/**
 * Sets how many measures the score holds, dropping from the end or growing
 * with empty bars. The cursor is pulled back inside the score when its
 * measure was one of the dropped ones.
 */
export function withMeasureCount(score: Score, cursor: Cursor, count: number): Edit {
  const clamped = Math.min(Math.max(count, 1), MAX_MEASURES)
  return {
    score: {
      ...score,
      measures:
        clamped <= score.measures.length
          ? score.measures.slice(0, clamped)
          : [
              ...score.measures,
              ...Array.from({ length: clamped - score.measures.length }, (): Entry[] => []),
            ],
    },
    cursor: { measure: Math.min(cursor.measure, clamped - 1), index: cursor.index },
  }
}

/**
 * The entry the arrow keys act on: the one under the cursor, or -- when the
 * cursor sits on the empty append slot, which is where it lands right after
 * writing -- the one just before it. Either way it is the column the grid is
 * highlighting, so the note that moves is the note that looks selected.
 */
export function selectedIndex(score: Score, cursor: Cursor): number | null {
  const entries = entriesAt(score, cursor.measure)
  if (entries[cursor.index]) return cursor.index
  if (entries[cursor.index - 1]) return cursor.index - 1
  return null
}

/**
 * Moves the selected beat, either in pitch (`semitones`) or across strings
 * at the same pitch (`strings`). The whole beat moves together, or not at
 * all: half a chord shifting is never what an arrow key meant, and a move
 * that would land two notes on the same string has nowhere coherent to go.
 * Rests have no pitch, and a move off the end of the neck has no target:
 * null, and the score stays as it is.
 *
 * `landed` is where the beat ended up, so the caller can point the next note
 * at the same string and fret; `index` names the column for its undo key.
 */
export function moveBeat(
  score: Score,
  cursor: Cursor,
  { semitones = 0, strings = 0 }: { semitones?: number; strings?: number },
): { score: Score; index: number; landed: Fingering[] } | null {
  const index = selectedIndex(score, cursor)
  if (index === null) return null
  const entry = entriesAt(score, cursor.measure)[index]
  if (entry.kind !== 'note') return null
  const moved = entry.notes.map((note) =>
    semitones ? transpose(note, semitones) : restring(note, strings),
  )
  if (moved.some((note) => note === null)) return null
  const landed = sortedFingerings(moved as Fingering[])
  if (new Set(landed.map((note) => note.string)).size !== landed.length) return null
  return {
    score: withEntry(score, { measure: cursor.measure, index }, () => ({ ...entry, notes: landed })),
    index,
    landed,
  }
}
