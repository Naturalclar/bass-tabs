import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Score } from './model.ts'
import { columnAt, schedule, secondsPerTick } from './playback.ts'

/** Hz for a MIDI note number: 69 is A4 at 440 Hz. */
function frequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

/**
 * Placed between "now" and the first note so its attack is not already in the
 * past by the time the graph is built -- a note scheduled at a time gone by
 * plays clipped.
 */
const LEAD_SECONDS = 0.05

/**
 * Sounding the open score through Web Audio. A run is one node graph hung off
 * one output node; silencing it is disconnecting that node, which stops
 * everything upstream at once and lets the whole graph be collected. The
 * AudioContext itself is created on the first play -- inside the click, which
 * is the user gesture autoplay policy wants -- and reused after that.
 *
 * Pausing is not a suspended context: the graph is torn down like any other
 * stop, and only the tick that was sounding is kept. Resuming is `playFrom`
 * with that tick, which is the same path the measure-click head-start uses.
 * That way there is one way to start sounding, and a pause survives anything
 * that rebuilds the note list -- a tempo change while paused simply resumes at
 * the new tempo.
 */
export function usePlayback(score: Score) {
  const [playing, setPlaying] = useState(false)
  /** The column being sounded right now, for the grid to highlight. */
  const [position, setPosition] = useState<{ measure: number; index: number } | null>(null)
  const context = useRef<AudioContext | null>(null)
  /** The one node this run hangs off the destination by. */
  const run = useRef<AudioNode | null>(null)
  const endTimer = useRef<number | null>(null)
  const positionFrame = useRef<number | null>(null)
  /** Where the running tick had got to, read by `pause`. */
  const tickNow = useRef<() => number>(() => 0)
  /** Where a resume would start. Non-null only while paused. */
  const [pausedAt, setPausedAt] = useState<number | null>(null)

  const notes = useMemo(() => schedule(score), [score])

  /**
   * Silences the graph and clears the timers. Both stopping and pausing go
   * through this; what tells them apart is only what happens to `pausedAt`,
   * which is the caller's to set.
   */
  const silence = useCallback(() => {
    if (endTimer.current !== null) {
      window.clearTimeout(endTimer.current)
      endTimer.current = null
    }
    if (positionFrame.current !== null) {
      cancelAnimationFrame(positionFrame.current)
      positionFrame.current = null
    }
    run.current?.disconnect()
    run.current = null
    setPlaying(false)
    setPosition(null)
  }, [])

  /** Stop: nothing is sounding and nothing is held, so the next play is from the top. */
  const stop = useCallback(() => {
    silence()
    setPausedAt(null)
  }, [silence])

  /**
   * Plays from a tick -- 0 is the top, and a measure's start comes from
   * `ticksAt`. Notes before the tick are skipped, everything after shifts
   * left, which is what "play from here" means.
   */
  const playFrom = useCallback((fromTick: number) => {
    if (notes.length === 0 || typeof AudioContext === 'undefined') return
    silence()
    setPausedAt(null)
    const ctx = (context.current ??= new AudioContext())
    // The context starts suspended until a user gesture -- play is one.
    void ctx.resume()

    const master = ctx.createGain()
    master.gain.value = 0.25
    // One lowpass under all the notes: a bare sawtooth is harsh, and the
    // filtered one still carries enough harmonics to place the pitch of a low
    // E whose 41 Hz fundamental small speakers cannot reproduce at all.
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1500
    master.connect(filter)
    filter.connect(ctx.destination)

    const perTick = secondsPerTick(score.tempo)
    const first = ctx.currentTime + LEAD_SECONDS
    let lastEnd = first
    for (const note of notes) {
      if (note.startTicks < fromTick) continue
      const start = first + (note.startTicks - fromTick) * perTick
      const end = start + note.durationTicks * perTick
      lastEnd = Math.max(lastEnd, end)

      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = frequency(note.midi)

      // A pluck: quick rise, decay through the body, silent by the note's own
      // end -- so repeated notes on one pitch stay separate instead of
      // running together into one long tone.
      const envelope = ctx.createGain()
      const attackEnd = Math.min(start + 0.005, end)
      const releaseStart = Math.max(attackEnd, end - 0.04)
      envelope.gain.setValueAtTime(0, start)
      envelope.gain.linearRampToValueAtTime(1, attackEnd)
      envelope.gain.linearRampToValueAtTime(0.4, releaseStart)
      envelope.gain.linearRampToValueAtTime(0, end)

      osc.connect(envelope)
      envelope.connect(master)
      osc.start(start)
      osc.stop(end)
    }

    run.current = filter
    setPlaying(true)
    endTimer.current = window.setTimeout(
      () => stop(),
      (lastEnd - ctx.currentTime + 0.1) * 1000,
    )

    // Where the run has got to, in ticks. The lead-in is still ahead of the
    // first note when this is called early, so it never reads before the start.
    // The follow loop names the column from this, and `pause` keeps the number
    // itself -- which is why it is a ref and not something recomputed there:
    // only this closure knows the run's own `first` and tempo.
    const currentTick = () => Math.max(fromTick, fromTick + (ctx.currentTime - first) / perTick)
    tickNow.current = currentTick

    // Follow along on the grid: convert elapsed time back to ticks and let
    // the pure helper name the column. State changes only when the column
    // does, so the animation loop does not re-render sixty times a second.
    let shown: { measure: number; index: number } | null = null
    const follow = () => {
      const column = columnAt(score, currentTick())
      if (column?.measure !== shown?.measure || column?.index !== shown?.index) {
        shown = column
        setPosition(column)
      }
      positionFrame.current = requestAnimationFrame(follow)
    }
    follow()
  }, [notes, score, silence, stop])

  /** Play -- or carry on from where a pause left off. */
  const play = useCallback(() => playFrom(pausedAt ?? 0), [pausedAt, playFrom])

  /**
   * Pause: keep the tick that was sounding, silence everything else. The
   * highlight stays on that column rather than going out with the sound, so
   * the grid keeps showing where a resume will pick up.
   */
  const pause = useCallback(() => {
    if (!playing) return
    const at = tickNow.current()
    silence()
    setPausedAt(at)
    setPosition(columnAt(score, at))
  }, [playing, score, silence])

  // Unmount: silence whatever is sounding and give the audio device back.
  useEffect(
    () => () => {
      if (endTimer.current !== null) window.clearTimeout(endTimer.current)
      if (positionFrame.current !== null) cancelAnimationFrame(positionFrame.current)
      run.current?.disconnect()
      void context.current?.close()
    },
    [],
  )

  return {
    playing,
    /** Held mid-score: the play button offers to carry on, stop clears it. */
    paused: pausedAt !== null,
    position,
    canPlay: notes.length > 0,
    play,
    playFrom,
    pause,
    stop,
  }
}
