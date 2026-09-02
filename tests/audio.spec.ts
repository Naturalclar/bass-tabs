import { test, expect } from '@playwright/test'
import { estimateGrid, onsetTimes, type Grid } from '../src/editor/audio.ts'
import { noteDurations } from '../src/editor/quantize.ts'
import type { Duration } from '../src/editor/model.ts'

/**
 * 音声のリズム推定 (#75) の純関数検査。正解の分かる入力は合成で作る --
 * 画像取り込みが合成スクリーンショットを使うのと同じ流儀で、既知の時刻に
 * 減衰音を置いた PCM なら、オンセットの正解も格子の正解も自明。
 */

const RATE = 44100

/** 既知の時刻に減衰する 220Hz の音を置いた PCM。乱数は使わない。 */
function clickTrain(times: number[], seconds: number, amplitudes?: number[]): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE))
  times.forEach((time, index) => {
    const amplitude = amplitudes?.[index] ?? 0.8
    const start = Math.round(time * RATE)
    const length = Math.round(0.15 * RATE)
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const decay = Math.exp((-6 * i) / length)
      samples[start + i] += amplitude * decay * Math.sin((2 * Math.PI * 220 * i) / RATE)
    }
  })
  return samples
}

test.describe('オンセット検出', () => {
  test('置いた時刻がそのまま返る', () => {
    const placed = [0.2, 0.7, 1.3, 1.6]
    const found = onsetTimes(clickTrain(placed, 2), RATE)
    expect(found).toHaveLength(placed.length)
    found.forEach((time, index) => {
      expect(Math.abs(time - placed[index])).toBeLessThan(0.03)
    })
  })

  test('無音からは何も出ない', () => {
    expect(onsetTimes(new Float32Array(RATE), RATE)).toEqual([])
  })

  test('音量が揃っていなくても全部拾う', () => {
    // 相対閾値だけだと大きい音の近くの小さい音を落とし、絶対閾値だけだと
    // 静かな発音を落とす。両方の合わせ技が効いていることの検査。
    const placed = [0.2, 0.7, 1.2]
    const found = onsetTimes(clickTrain(placed, 2, [1.0, 0.3, 0.6]), RATE)
    expect(found).toHaveLength(3)
  })

  test('近すぎる 2 つの立ち上がりは 1 つの発音', () => {
    // 40ms 差はビブラートやトレモロの揺れであって別の音ではない
    const found = onsetTimes(clickTrain([0.5, 0.54], 1), RATE)
    expect(found).toHaveLength(1)
  })
})

test.describe('格子の推定', () => {
  test('等間隔の列から単位と位相が出る', () => {
    // 0.3 秒格子の 0, 2, 3, 6, 8 目盛 (8 分格子、♩=100 相当)
    const grid = estimateGrid([0.1, 0.7, 1.0, 1.9, 2.5])
    expect(grid).not.toBeNull()
    expect(Math.abs(grid!.unit - 0.3)).toBeLessThan(0.01)
    expect(grid!.unitTicks).toBe(12)
  })

  test('演奏の揺れは飲み込む', () => {
    const grid = estimateGrid([0.11, 0.68, 1.02, 1.92, 2.48])
    expect(grid).not.toBeNull()
    expect(grid!.unitTicks).toBe(12)
  })

  test('格子に乗らない列は推定しない', () => {
    // 無理に丸めると「それらしく見える間違い」になるので null が正しい
    expect(estimateGrid([0.1, 0.53, 0.71, 1.63, 1.94])).toBeNull()
  })

  test('3 音未満では推定しない', () => {
    expect(estimateGrid([0.1, 0.6])).toBeNull()
    expect(estimateGrid([])).toBeNull()
  })
})

test.describe('音価の量子化', () => {
  const grid: Grid = { unit: 0.3, phase: 0.1, unitTicks: 12 }
  const short = (duration: Duration) =>
    `${duration.value}${duration.dotted ? '.' : ''}${duration.triplet ? 't' : ''}`

  test('間隔がそのまま音価になり、最後は直前を引き継ぐ', () => {
    // 目盛 0, 2, 3: ♩ ♪、最後の音は次が無いので直前と同じ ♪
    const durations = noteDurations([0.1, 0.7, 1.0], grid, { beats: 4, beatType: 4 })
    expect(durations?.map(short)).toEqual(['4', '8', '8'])
  })

  test('付点も表にある長さなら書ける', () => {
    // 目盛 0, 3, 4: 付点四分 + 8 分
    const durations = noteDurations([0.1, 1.0, 1.3], grid, { beats: 4, beatType: 4 })
    expect(durations?.map(short)).toEqual(['4.', '8', '8'])
  })

  test('モデルに無い長さが出たら全体を断る', () => {
    // 目盛 0, 5: 60 tick (♩ + 8 分) はタイ無しでは書けない
    expect(noteDurations([0.1, 1.6, 1.9], grid, { beats: 4, beatType: 4 })).toBeNull()
  })

  test('小節線をまたぐ音は断る', () => {
    // 4 分格子で目盛 0, 3, 5: 2 音目が 3 拍目から 5 拍目まで -- 小節線を
    // またぐのでタイが要るが、モデルに無い
    const quarters: Grid = { unit: 0.5, phase: 0, unitTicks: 24 }
    expect(noteDurations([0, 1.5, 2.5], quarters, { beats: 4, beatType: 4 })).toBeNull()
    // 2 分音符の列は 4/4 には収まるが、小節が 3 拍しかない 6/8 ではまたぐ:
    // 検査が拍子を見ている証拠
    const halves = noteDurations([0, 1.0, 2.0], quarters, { beats: 4, beatType: 4 })
    expect(halves?.map(short)).toEqual(['2', '2', '2'])
    expect(noteDurations([0, 1.0, 2.0], quarters, { beats: 6, beatType: 8 })).toBeNull()
  })

  test('同じ目盛に 2 つ来たら断る', () => {
    expect(noteDurations([0.1, 0.15, 0.7], grid, { beats: 4, beatType: 4 })).toBeNull()
  })
})
