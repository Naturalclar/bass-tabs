/**
 * 音声ファイルを譜面にする採譜 (#76): オンセットが「いつ」、ピッチが
 * 「どの音」、#75 の格子と量子化が「どの長さ」を決める。DSP は audio.ts /
 * quantize.ts の純関数で、このモジュールはデコードと組み立ての配線だけ
 * (imageImport.ts が OCR の配線であるのと同じ役割)。
 *
 * 入力はベース単体の録音が前提。ミックスされた曲からベースを抜き出すのは
 * 音源分離 (#61) の領域で、ここでは扱わない。和音も扱わない -- 単音の
 * ピッチ推定と多声の分離は別次元の問題で、まず単音を成立させる。
 *
 * 方針は画像取り込みと同じ refuse-don't-round: ピッチの取れない発音は
 * 休符にして件数を出し、リズムは格子に乗ったときだけ付けて、乗らなければ
 * 全部 8 分で入れる。
 */

import { estimateGrid, onsetTimes, pitchAt } from './audio.ts'
import { noteDurations } from './quantize.ts'
import { intoMeasures } from './imageImport.ts'
import { emptyScore, MAX_MEASURES, type Duration, type Entry, type Score } from './model.ts'
import { positionFor, TUNINGS } from './tuning.ts'

export type AudioImport =
  | { ok: true; score: Score; unread: number; timed: boolean }
  | { ok: false; reason: 'unreadable' | 'no-notes' | 'too-long' }

const IMPORT_VALUE = 8

export async function fromAudioFile(file: File, title: string): Promise<AudioImport> {
  const audio = await decodeMonoSamples(await file.arrayBuffer()).catch(() => null)
  if (!audio) return { ok: false, reason: 'unreadable' }

  const onsets = onsetTimes(audio.samples, audio.sampleRate)
  if (onsets.length === 0) return { ok: false, reason: 'no-notes' }

  const base = {
    title,
    time: { beats: 4, beatType: 4 },
    keyFifths: 0,
    tempo: emptyScore().tempo,
    tuning: emptyScore().tuning,
  }

  // リズム: 格子に乗り、モデルに書ける長さになったときだけ (#75 の流儀)。
  // 乗らなければ全部 8 分 -- それらしく見える間違いを作らない。
  const grid = estimateGrid(onsets)
  const durations = grid ? noteDurations(onsets, grid, base.time) : null
  const fallback: Duration = { value: IMPORT_VALUE, dotted: false, triplet: false }

  // ピッチ: 発音ごとに測り、取れないもの・楽器の音域の外のものは休符に
  // して数える。消える代わりに残る隙間は、見えて直せる。
  const tuning = TUNINGS[base.tuning]
  let unread = 0
  const entries: Entry[] = onsets.map((at, index) => {
    const duration = durations?.[index] ?? fallback
    const midi = pitchAt(audio.samples, audio.sampleRate, at)
    const position = midi === null ? null : positionFor(tuning, midi)
    if (!position) {
      unread++
      return { kind: 'rest', ...duration }
    }
    return { kind: 'note', notes: [position], ...duration }
  })
  if (entries.every((entry) => entry.kind === 'rest')) return { ok: false, reason: 'no-notes' }

  const measures = intoMeasures(entries, base)
  if (measures.length > MAX_MEASURES) return { ok: false, reason: 'too-long' }
  return { ok: true, score: { ...base, measures }, unread, timed: durations !== null }
}

/**
 * ブラウザがデコードできるものは何でもモノラル PCM に。ほどけなければ
 * null。動画ファイルの音声トラック (VideoImport) もここを通る -- webm も
 * mp3 も `decodeAudioData` から見れば同じ「音の入ったバイト列」。
 */
export async function decodeMonoSamples(
  data: ArrayBuffer,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  try {
    const context = new OfflineAudioContext(1, 1, 44100)
    const decoded = await context.decodeAudioData(data)
    const samples = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const channelData = decoded.getChannelData(channel)
      for (let i = 0; i < channelData.length; i++) {
        samples[i] += channelData[i] / decoded.numberOfChannels
      }
    }
    return { samples, sampleRate: decoded.sampleRate }
  } catch {
    return null
  }
}
