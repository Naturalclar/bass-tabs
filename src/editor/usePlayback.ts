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
 * Sounding the open score through Web Audio. This is a proofing tool -- play
 * once from the top, hear whether the entered notes are right -- so there is
 * deliberately no cursor, no looping, and no following the page.
 *
 * A run is one node graph hung off one output node; stopping is disconnecting
 * that node, which silences everything upstream at once and lets the whole
 * graph be collected. The AudioContext itself is created on the first play --
 * inside the click, which is the user gesture autoplay policy wants -- and
 * reused after that.
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

  const notes = useMemo(() => schedule(score), [score])

  const stop = useCallback(() => {
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

  /**
   * Plays from a tick -- 0 is the top, and a measure's start comes from
   * `ticksAt`. Notes before the tick are skipped, everything after shifts
   * left, which is what "play from here" means.
   */
  const playFrom = useCallback((fromTick: number) => {
    if (notes.length === 0 || typeof AudioContext === 'undefined') return
    stop()
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

    // Follow along on the grid: convert elapsed time back to ticks and let
    // the pure helper name the column. State changes only when the column
    // does, so the animation loop does not re-render sixty times a second.
    let shown: { measure: number; index: number } | null = null
    const follow = () => {
      const tick = fromTick + (ctx.currentTime - first) / perTick
      const column = tick < fromTick ? columnAt(score, fromTick) : columnAt(score, tick)
      if (column?.measure !== shown?.measure || column?.index !== shown?.index) {
        shown = column
        setPosition(column)
      }
      positionFrame.current = requestAnimationFrame(follow)
    }
    follow()
  }, [notes, score, stop])

  const play = useCallback(() => playFrom(0), [playFrom])

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
    position,
    canPlay: notes.length > 0,
    play,
    playFrom,
    stop,
  }
}
