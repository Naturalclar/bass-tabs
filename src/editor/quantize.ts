/**
 * 時刻を音価にする側の土台 (#75): 推定した格子 (audio.ts) の上にオンセット
 * 列を置き、音符ごとの Duration を導く。videoScan.ts / tabImage.ts と同じく
 * 数値だけを受ける純関数で、ブラウザ抜きで直接検査できる。
 *
 * 方針は「数が合ったときだけ使う」(#75 の案 1) の後段: 呼び出し側が音数と
 * オンセット数の一致を確かめてから渡し、ここでも表現できない結果 -- 格子に
 * 乗らない・モデルに無い音価・小節線をまたぐ -- は null で断る。丸めて
 * 「それらしく見える間違い」を作るくらいなら、従来どおり全部 8 分のままの
 * ほうが正直、という線 (#11 が OCR について引いたのと同じ)。
 */

import { measureCapacity, type Duration, type TimeSignature } from './model.ts'
import type { Grid } from './audio.ts'

/** tick 数 → モデルが持てる音価。表に無い長さは表現できない。 */
const DURATION_OF_TICKS = new Map<number, Duration>([
  [6, { value: 16, dotted: false, triplet: false }],
  [9, { value: 16, dotted: true, triplet: false }],
  [12, { value: 8, dotted: false, triplet: false }],
  [18, { value: 8, dotted: true, triplet: false }],
  [24, { value: 4, dotted: false, triplet: false }],
  [36, { value: 4, dotted: true, triplet: false }],
  [48, { value: 2, dotted: false, triplet: false }],
  [72, { value: 2, dotted: true, triplet: false }],
  [96, { value: 1, dotted: false, triplet: false }],
])

/**
 * オンセット列を格子に乗せ、隣との間隔から各音の Duration を返す。
 * 最後の音には次のオンセットが無いので、直前の間隔を引き継ぐ (1 音だけ
 * なら格子 1 目盛)。どこかが表現できなければ全体を null で断る。
 *
 * 小節線の検査は先頭を小節頭と置いて行う。実際の追記位置 (appendRun) は
 * 書きかけの小節の続きかもしれないが、それは今の全部 8 分の取り込みでも
 * 同じ前提なので、ここで新たに嘘が増えるわけではない。
 */
export function noteDurations(
  onsets: number[],
  grid: Grid,
  time: TimeSignature,
): Duration[] | null {
  if (onsets.length === 0) return null

  const slots = onsets.map((t) => Math.round((t - grid.phase) / grid.unit))
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] <= slots[i - 1]) return null
  }

  const gapTicks: number[] = []
  for (let i = 1; i < slots.length; i++) gapTicks.push((slots[i] - slots[i - 1]) * grid.unitTicks)
  gapTicks.push(gapTicks.at(-1) ?? grid.unitTicks)

  const capacity = measureCapacity(time)
  const durations: Duration[] = []
  let at = 0
  for (const ticks of gapTicks) {
    const duration = DURATION_OF_TICKS.get(ticks)
    if (!duration) return null
    // 小節線をまたぐ音はタイが無いと書けない。またぐ結果になった時点で断る。
    if (Math.floor(at / capacity) !== Math.floor((at + ticks - 1) / capacity)) return null
    durations.push(duration)
    at += ticks
  }
  return durations
}
