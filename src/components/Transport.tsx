import { useState } from 'react'
import { MAX_TEMPO, MIN_TEMPO } from '../editor/model.ts'
import type { MidiStatus } from '../editor/useMidiInput.ts'

/**
 * Sounding the score and getting it out of the app. Split out of EditorPanel
 * (#87).
 */

type Props = {
  playing: boolean
  paused: boolean
  canPlay: boolean
  /** Whether the cursor is already at the top, which is all stop leaves to do. */
  atStart: boolean
  tempo: number
  midi: MidiStatus
  onTogglePlay: () => void
  onStop: () => void
  onTempo: (tempo: number) => void
  onConnectMidi: () => void
  onExport: () => void
  onExportMidi: () => void
}

function midiLabel(status: MidiStatus): string {
  switch (status.kind) {
    case 'unsupported':
      return 'MIDI 非対応のブラウザ'
    case 'denied':
      return 'MIDI が拒否されました'
    case 'connected':
      return status.inputs.length > 0
        ? `MIDI: ${status.inputs.join(', ')}`
        : 'MIDI 入力が見つかりません'
    case 'idle':
      return 'MIDI キーボードを使う'
  }
}

/**
 * Tempo. Values inside the range apply as they are typed; anything else stays
 * a draft and snaps back on blur. The tempo is score content now (printed as
 * ♩=N), but a wrong intermediate value cannot destroy anything the way a
 * measure count can -- and the commits coalesce under one key, so the whole
 * adjustment is one undo step.
 */
function TempoField({ tempo, onTempo }: { tempo: number; onTempo: (tempo: number) => void }) {
  const [draft, setDraft] = useState(String(tempo))
  const [shown, setShown] = useState(tempo)
  if (tempo !== shown) {
    setShown(tempo)
    setDraft(String(tempo))
  }

  return (
    <label className="editor-field">
      BPM
      <input
        type="number"
        min={MIN_TEMPO}
        max={MAX_TEMPO}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          const parsed = Number(e.target.value)
          if (Number.isFinite(parsed) && parsed >= MIN_TEMPO && parsed <= MAX_TEMPO) onTempo(parsed)
        }}
        onBlur={() => setDraft(String(tempo))}
      />
    </label>
  )
}

export function Transport(props: Props) {
  return (
    <div className="editor-row">
      {/* Two buttons, not one toggle with three faces. Play/pause is the one
          you press repeatedly while working through a passage; stop is the
          one that puts you back at the top, and having to pass through it to
          resume was the reason a pause was wanted at all. */}
      <button
        type="button"
        className="button"
        aria-pressed={props.playing}
        aria-label={props.playing ? '一時停止' : props.paused ? '続きから再生' : '再生'}
        title={props.playing ? '一時停止' : props.paused ? '続きから再生' : '再生'}
        onClick={props.onTogglePlay}
        disabled={!props.playing && !props.canPlay}
      >
        {/* currentColor keeps the icon on the same contrast budget the
            dark-scheme test measures for text; an emoji would not be. */}
        {props.playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1.5" y="1" width="3" height="10" fill="currentColor" />
            <rect x="7.5" y="1" width="3" height="10" fill="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 1 L11 6 L2 11 Z" fill="currentColor" />
          </svg>
        )}
      </button>
      {/* Enabled only when it has something to undo: a run in progress, a
          pause held, or a cursor left somewhere other than the top. */}
      <button
        type="button"
        className="button"
        aria-label="停止"
        title="停止"
        onClick={props.onStop}
        disabled={!props.playing && !props.paused && props.atStart}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="1" y="1" width="10" height="10" fill="currentColor" />
        </svg>
      </button>
      <TempoField tempo={props.tempo} onTempo={props.onTempo} />
      <button
        type="button"
        className="button"
        onClick={props.onConnectMidi}
        disabled={props.midi.kind === 'unsupported' || props.midi.kind === 'connected'}
      >
        {midiLabel(props.midi)}
      </button>
      <button type="button" className="button" onClick={props.onExport}>
        MusicXML を書き出す
      </button>
      {/* MIDI carries the notes but not the tab: strings and frets have no
          representation in the format. One-way door, said so in README. */}
      <button type="button" className="button" onClick={props.onExportMidi}>
        MIDI を書き出す
      </button>
    </div>
  )
}
