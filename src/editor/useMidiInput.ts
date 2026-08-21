import { useCallback, useEffect, useRef, useState } from 'react'
import { positionFor } from './tuning.ts'

/**
 * Note entry from a MIDI keyboard, via the Web MIDI API.
 *
 * Support is not universal, and the API needs a secure context, so every state
 * here is a state the UI has to be able to show rather than an error to throw.
 */
export type MidiStatus =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'denied' }
  | { kind: 'connected'; inputs: string[] }

type MidiPort = { name?: string | null; onmidimessage: ((event: MessageEvent) => void) | null }
type MidiAccess = { inputs: Map<string, MidiPort> }
type MidiNavigator = Navigator & {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccess>
}

const NOTE_ON = 0x90

export function useMidiInput(onNote: (stringNumber: number, fret: number) => void) {
  // Whether the API exists is knowable before the first paint, so it is the
  // initial state rather than an effect that immediately re-renders.
  const [status, setStatus] = useState<MidiStatus>(() =>
    'requestMIDIAccess' in navigator ? { kind: 'idle' } : { kind: 'unsupported' },
  )
  // The handler changes on every edit (it closes over the cursor), but the MIDI
  // port must not be re-subscribed each time, so it is read through a ref.
  const handler = useRef(onNote)
  useEffect(() => {
    handler.current = onNote
  }, [onNote])

  const connect = useCallback(async () => {
    const request = (navigator as MidiNavigator).requestMIDIAccess
    if (!request) {
      setStatus({ kind: 'unsupported' })
      return
    }
    try {
      const access = await request.call(navigator)
      const inputs = [...access.inputs.values()]
      for (const input of inputs) {
        input.onmidimessage = (event) => {
          const data = (event as MessageEvent & { data?: Uint8Array }).data
          if (!data || data.length < 3) return
          const [statusByte, note, velocity] = data
          const command = statusByte & 0xf0
          // Many controllers send note-off as a note-on with zero velocity, so
          // velocity has to be checked as well as the command.
          if (command !== NOTE_ON || velocity === 0) return
          const position = positionFor(note)
          if (position) handler.current(position.string, position.fret)
        }
      }
      setStatus({ kind: 'connected', inputs: inputs.map((i) => i.name ?? 'MIDI 入力') })
    } catch {
      setStatus({ kind: 'denied' })
    }
  }, [])

  return { status, connect }
}
