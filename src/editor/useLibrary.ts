import { useCallback, useEffect, useState } from 'react'
import { emptyScore, type Score } from './model.ts'
import {
  newScoreId,
  readLibrary,
  removeScore,
  writeIndex,
  writeScore,
  type ScoreId,
  type StoredScore,
} from './storage.ts'

/** A library that always holds at least one score, so there is always one open. */
function initialLibrary(): { scores: StoredScore[]; currentId: ScoreId } {
  const stored = readLibrary()
  if (stored.currentId && stored.scores.length > 0) {
    return { scores: stored.scores, currentId: stored.currentId }
  }
  const first = { id: newScoreId(), score: emptyScore() }
  return { scores: [first], currentId: first.id }
}

/**
 * The scores around the one being edited: which exist, which is open, and
 * keeping localStorage in step with both. Nothing here knows about cursors or
 * undo -- the operations below deliberately carry no editing-state resets.
 * useEditor watches `currentId` and resets its own state when the open score
 * changes, so a new library operation cannot forget to.
 */
export function useLibrary() {
  const [library, setLibrary] = useState(initialLibrary)
  const { scores, currentId } = library
  const score = scores.find((entry) => entry.id === currentId)?.score ?? emptyScore()

  const setScore = useCallback((next: Score) => {
    setLibrary((current) => ({
      ...current,
      scores: current.scores.map((entry) =>
        entry.id === current.currentId ? { ...entry, score: next } : entry,
      ),
    }))
  }, [])

  // Only the score being edited is written on a keystroke. The index changes
  // when scores are added, removed or switched, so those write it themselves.
  useEffect(() => {
    writeScore(currentId, score)
  }, [currentId, score])

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
      const next = remaining.length > 0 ? remaining : [{ id: newScoreId(), score: emptyScore() }]
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
    },
    [currentId, scores],
  )

  return {
    scores,
    currentId,
    score,
    setScore,
    selectScore,
    addScore,
    importScores,
    deleteScore,
  }
}
