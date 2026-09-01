import {
  MAX_MEASURES,
  MAX_TEMPO,
  MIN_TEMPO,
  NOTE_VALUES,
  emptyScore,
  type Entry,
  type Score,
  type TimeSignature,
} from './model.ts'
import { MAX_FRET, STRINGS } from './tuning.ts'

/**
 * Reading and writing the one saved score.
 *
 * The stored value is the only input to this app that nobody typed and nothing
 * type-checks: it was written by whatever version of the code the person last
 * ran. A field that has since been renamed, or a shape that predates a change,
 * reaches `useEditor` as a `Score` the compiler believes in, and the first
 * render throws on it. Because it is *persisted*, that turns into an app that
 * fails to start and keeps failing on every reload, with no way back from the
 * UI -- not even the 新規 button, which never renders.
 *
 * So the rule here is that nothing leaves this module unless every field the
 * app actually reads has been checked. Anything else is discarded and the
 * person starts from an empty score, which is recoverable; a blank page is not.
 */

/**
 * One key per score, plus an index naming them and remembering which one was
 * open. Keeping each score in its own key is what lets an edit write only the
 * score being edited: the app saves on every keystroke, and rewriting the whole
 * library that often would get slower with every score added.
 *
 * The index deliberately holds no titles. A title would then live in two places
 * and have to be kept in step on every keystroke; instead the library is read
 * in full at startup -- the scores are small and there are only ever as many as
 * one person writes -- and the list is served from memory after that.
 */
const INDEX_KEY = 'bass-tabs:index'
const SCORE_KEY_PREFIX = 'bass-tabs:score:'

/**
 * Bumping this discards every stored score. Do that when the shape of `Score`
 * changes in a way the validator below would still accept -- a renamed field
 * with a compatible type, a changed unit, a changed meaning.
 */
const STORAGE_VERSION = 5

const BEAT_TYPES = [1, 2, 4, 8, 16]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTimeSignature(value: unknown): value is TimeSignature {
  if (!isRecord(value)) return false
  return (
    typeof value.beats === 'number' &&
    Number.isInteger(value.beats) &&
    value.beats >= 1 &&
    value.beats <= 32 &&
    typeof value.beatType === 'number' &&
    BEAT_TYPES.includes(value.beatType)
  )
}

function isFingering(value: unknown): value is { string: number; fret: number } {
  if (!isRecord(value)) return false
  // An unknown string number reaches `stringByNumber`, which throws by design.
  if (!STRINGS.some((string) => string.number === value.string)) return false
  return (
    typeof value.fret === 'number' &&
    Number.isInteger(value.fret) &&
    value.fret >= 0 &&
    value.fret <= MAX_FRET
  )
}

function isEntry(value: unknown): value is Entry {
  if (!isRecord(value)) return false
  if (typeof value.dotted !== 'boolean') return false
  if (typeof value.triplet !== 'boolean') return false
  // Exclusive by construction: `ticks` would otherwise silently ignore the
  // dot, and a stored score is the one input nothing type-checks.
  if (value.dotted && value.triplet) return false
  if (typeof value.value !== 'number') return false
  if (!(NOTE_VALUES as readonly number[]).includes(value.value)) return false
  if (value.kind === 'rest') return true
  if (value.kind !== 'note') return false
  if (!Array.isArray(value.notes) || value.notes.length === 0) return false
  if (!value.notes.every((note) => isFingering(note))) return false
  // The same string cannot sound twice in one beat.
  return new Set(value.notes.map((note) => (note as { string: number }).string)).size ===
    value.notes.length
}

export function isScore(value: unknown): value is Score {
  if (!isRecord(value)) return false
  if (typeof value.title !== 'string') return false
  if (typeof value.keyFifths !== 'number' || !Number.isInteger(value.keyFifths)) return false
  if (
    typeof value.tempo !== 'number' ||
    !Number.isInteger(value.tempo) ||
    value.tempo < MIN_TEMPO ||
    value.tempo > MAX_TEMPO
  ) {
    return false
  }
  if (!isTimeSignature(value.time)) return false
  if (!Array.isArray(value.measures)) return false
  if (value.measures.length < 1 || value.measures.length > MAX_MEASURES) return false
  return value.measures.every(
    (measure) => Array.isArray(measure) && measure.every((entry) => isEntry(entry)),
  )
}

export type ScoreId = string

/** A score plus the id the library knows it by. Titles are for people; ids are for us. */
export type StoredScore = { id: ScoreId; score: Score }

export type Library = { scores: StoredScore[]; currentId: ScoreId | null }

export function newScoreId(): ScoreId {
  return crypto.randomUUID()
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    // Unparseable, or storage itself throwing (a private window can).
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Out of quota or storage blocked: losing persistence is not worth
    // interrupting the person mid-edit.
  }
}

/**
 * Version 2 stored a single-note shape (`string`/`fret` on the entry itself);
 * version 3 holds a `notes` array so a beat can be a chord. The lift is
 * mechanical, and people already have scores saved -- discarding them over a
 * field move would be the exact silent loss this module exists to prevent.
 */
function fromVersion2(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.measures)) return value
  return {
    ...value,
    measures: value.measures.map((measure) =>
      Array.isArray(measure)
        ? measure.map((entry) =>
            isRecord(entry) && entry.kind === 'note'
              ? {
                  kind: 'note',
                  notes: [{ string: entry.string, fret: entry.fret }],
                  value: entry.value,
                  dotted: entry.dotted,
                }
              : entry,
          )
        : measure,
    ),
  }
}

/** Version 3 had no tempo; the default fills in, same style as fromVersion2. */
function fromVersion3(value: unknown): unknown {
  if (!isRecord(value)) return value
  return { ...value, tempo: emptyScore().tempo }
}

/** Version 4 had no tuplets: every entry it stored was a straight one. */
function fromVersion4(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.measures)) return value
  return {
    ...value,
    measures: value.measures.map((measure) =>
      Array.isArray(measure)
        ? measure.map((entry) => (isRecord(entry) ? { ...entry, triplet: false } : entry))
        : measure,
    ),
  }
}

function readScore(id: ScoreId): Score | null {
  const parsed = read(SCORE_KEY_PREFIX + id)
  if (!isRecord(parsed)) return null
  // One lift per version step, applied in order from whatever version the
  // score was written at: an old score walks the chain instead of needing a
  // rule for every pair of versions.
  const LIFTS: Record<number, (value: unknown) => unknown> = {
    2: fromVersion2,
    3: fromVersion3,
    4: fromVersion4,
  }
  const from = parsed.version
  if (typeof from !== 'number' || from < 2 || from > STORAGE_VERSION) return null
  let lifted = parsed.score
  for (let version = from; version < STORAGE_VERSION; version++) {
    lifted = LIFTS[version](lifted)
  }
  return isScore(lifted) ? lifted : null
}

/**
 * Everything worth restoring. A score that fails validation is dropped rather
 * than handed on: the stored value is the one input nothing type-checks, and a
 * shape the app cannot read would otherwise fail on *every* reload with no way
 * back from the UI.
 */
export function readLibrary(): Library {
  const parsed = read(INDEX_KEY)
  // The index's own shape has not changed since version 2, and it is the
  // door to the migratable scores: refusing it would orphan them all.
  if (
    !isRecord(parsed) ||
    typeof parsed.version !== 'number' ||
    parsed.version < 2 ||
    parsed.version > STORAGE_VERSION
  ) {
    return { scores: [], currentId: null }
  }
  const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((id) => typeof id === 'string') : []

  const scores: StoredScore[] = []
  for (const id of ids) {
    const score = readScore(id)
    if (score) scores.push({ id, score })
  }
  const currentId =
    typeof parsed.currentId === 'string' && scores.some((entry) => entry.id === parsed.currentId)
      ? parsed.currentId
      : (scores[0]?.id ?? null)
  return { scores, currentId }
}

export function writeIndex(ids: ScoreId[], currentId: ScoreId | null): void {
  write(INDEX_KEY, { version: STORAGE_VERSION, ids, currentId })
}

export function writeScore(id: ScoreId, score: Score): void {
  write(SCORE_KEY_PREFIX + id, { version: STORAGE_VERSION, score })
}

export function removeScore(id: ScoreId): void {
  try {
    localStorage.removeItem(SCORE_KEY_PREFIX + id)
  } catch {
    // Same as write: not worth interrupting anyone over.
  }
}
