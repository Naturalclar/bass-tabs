import type { Score } from './model.ts'
import { isScore, type StoredScore } from './storage.ts'

/**
 * The whole library as one file, so the scores can leave the browser.
 *
 * `localStorage` is the only place they live: clearing site data or moving to
 * another machine loses everything written so far. This is the way back.
 *
 * The file carries its own version, separate from `STORAGE_VERSION`. A file
 * outlives the browser that wrote it -- someone restores a backup from months
 * ago -- so the two need to be able to move independently.
 */

const FORMAT = 'bass-tabs-library'
const FORMAT_VERSION = 1

export type Backup = { format: string; version: number; scores: { title: string; score: Score }[] }

export function toBackup(scores: StoredScore[]): string {
  const backup: Backup = {
    format: FORMAT,
    version: FORMAT_VERSION,
    // Ids are deliberately left out: they identify a score inside one browser's
    // library, and importing mints new ones so a restore never collides with
    // whatever is already saved.
    scores: scores.map((entry) => ({ title: entry.score.title, score: entry.score })),
  }
  return JSON.stringify(backup, null, 2)
}

export type ImportResult =
  | { ok: true; scores: Score[] }
  | { ok: false; reason: 'unreadable' | 'wrong-format' | 'wrong-version' | 'no-scores' }

/**
 * Reads a backup file. Every score goes through the same validator the stored
 * ones do -- a file is chosen by a person rather than written by us, so it is
 * even less trustworthy than storage, and #14 is the reminder of what an
 * unvalidated score does to this app.
 */
export function fromBackup(text: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'unreadable' }
  const backup = parsed as Partial<Backup>
  if (backup.format !== FORMAT) return { ok: false, reason: 'wrong-format' }
  if (backup.version !== FORMAT_VERSION) return { ok: false, reason: 'wrong-version' }
  if (!Array.isArray(backup.scores)) return { ok: false, reason: 'unreadable' }

  const scores = backup.scores
    .map((entry) => (typeof entry === 'object' && entry !== null ? entry.score : null))
    .filter((score): score is Score => isScore(score))
  if (scores.length === 0) return { ok: false, reason: 'no-scores' }
  return { ok: true, scores }
}
