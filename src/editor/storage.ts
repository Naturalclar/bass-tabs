import { NOTE_VALUES, type Entry, type Score, type TimeSignature } from './model.ts'
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

const STORAGE_KEY = 'bass-tabs:score'

/**
 * Bumping this discards every stored score. Do that when the shape of `Score`
 * changes in a way the validator below would still accept -- a renamed field
 * with a compatible type, a changed unit, a changed meaning.
 */
const STORAGE_VERSION = 1

/** Mirrors `setMeasureCount`'s own clamp, so a load cannot produce a score the editor would refuse to make. */
const MAX_MEASURES = 64

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

function isEntry(value: unknown): value is Entry {
  if (!isRecord(value)) return false
  if (typeof value.dotted !== 'boolean') return false
  if (typeof value.value !== 'number') return false
  if (!(NOTE_VALUES as readonly number[]).includes(value.value)) return false
  if (value.kind === 'rest') return true
  if (value.kind !== 'note') return false
  // An unknown string number reaches `stringByNumber`, which throws by design.
  if (!STRINGS.some((string) => string.number === value.string)) return false
  return (
    typeof value.fret === 'number' &&
    Number.isInteger(value.fret) &&
    value.fret >= 0 &&
    value.fret <= MAX_FRET
  )
}

function isScore(value: unknown): value is Score {
  if (!isRecord(value)) return false
  if (typeof value.title !== 'string') return false
  if (typeof value.keyFifths !== 'number' || !Number.isInteger(value.keyFifths)) return false
  if (!isTimeSignature(value.time)) return false
  if (!Array.isArray(value.measures)) return false
  if (value.measures.length < 1 || value.measures.length > MAX_MEASURES) return false
  return value.measures.every(
    (measure) => Array.isArray(measure) && measure.every((entry) => isEntry(entry)),
  )
}

/** The saved score, or null when there is nothing usable to restore. */
export function readStoredScore(): Score | null {
  let parsed: unknown
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    parsed = JSON.parse(raw)
  } catch {
    // Unparseable, or storage itself throwing (a private window can).
    return null
  }

  if (isRecord(parsed) && 'version' in parsed) {
    if (parsed.version !== STORAGE_VERSION) return null
    return isScore(parsed.score) ? parsed.score : null
  }

  // Written before the envelope existed: keep it if it still validates, so
  // upgrading does not throw away work in progress.
  return isScore(parsed) ? parsed : null
}

export function writeStoredScore(score: Score): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, score }))
  } catch {
    // Out of quota or storage blocked: losing persistence is not worth
    // interrupting the person mid-edit.
  }
}
