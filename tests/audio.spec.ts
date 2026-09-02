import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateGrid, onsetTimes, pitchAt, type Grid } from '../src/editor/audio.ts'
import { noteDurations } from '../src/editor/quantize.ts'
import type { Duration } from '../src/editor/model.ts'
import { asciiFixtureDir, openEditor } from './helpers.ts'

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

/** 既知の基本周波数の倍音列を置く。振幅は倍音番号ごとに指定。 */
function tone(
  samples: Float32Array,
  at: number,
  frequency: number,
  harmonics: number[] = [1, 0.5, 0.33, 0.25],
) {
  const start = Math.round(at * RATE)
  const length = Math.round(0.4 * RATE)
  for (let i = 0; i < length && start + i < samples.length; i++) {
    const decay = Math.exp((-3 * i) / length)
    harmonics.forEach((amplitude, index) => {
      samples[start + i] +=
        0.5 * amplitude * decay * Math.sin((2 * Math.PI * frequency * (index + 1) * i) / RATE)
    })
  }
}

/** 乱数を使わない「雑音」: 線形合同法で毎回同じ列。 */
function noise(samples: Float32Array, at: number, seconds: number) {
  let seed = 1
  const start = Math.round(at * RATE)
  for (let i = 0; i < Math.round(seconds * RATE) && start + i < samples.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    samples[start + i] = (seed / 2147483648 - 0.5) * 0.8
  }
}

/** 16bit PCM モノラルの WAV。ブラウザ抜きで正解の分かる入力を作れる。 */
function wavBytes(samples: Float32Array): Buffer {
  const data = Buffer.alloc(44 + samples.length * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(36 + samples.length * 2, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20) // PCM
  data.writeUInt16LE(1, 22) // mono
  data.writeUInt32LE(RATE, 24)
  data.writeUInt32LE(RATE * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((value, index) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + index * 2)
  })
  return data
}

test.describe('ピッチの推定', () => {
  test('ベースの音域の基本周波数が MIDI ノートで当たる', () => {
    // 開放弦と押さえた音を音域の端から: E1 (開放 E) から G3 (G 弦 12f) まで
    for (const [frequency, midi] of [
      [41.203, 28],
      [55.0, 33],
      [73.416, 38],
      [110.0, 45],
      [196.0, 55],
    ] as const) {
      const samples = new Float32Array(RATE)
      tone(samples, 0.1, frequency)
      expect(pitchAt(samples, RATE, 0.1), `${frequency} Hz`).toBe(midi)
    }
  })

  test('基音が弱くてもオクターブ上に誤らない', () => {
    // ベースの録音の典型 (#76): 基音はほぼ消えていて倍音だけ強い。
    // スペクトルの最大値を取る素朴な方法はここで 12 フレットずれる。
    const samples = new Float32Array(RATE)
    tone(samples, 0.1, 41.203, [0.05, 1.0, 0.7, 0.3])
    expect(pitchAt(samples, RATE, 0.1)).toBe(28)
  })

  test('雑音からは音程を出さない', () => {
    const samples = new Float32Array(RATE)
    noise(samples, 0.1, 0.4)
    expect(pitchAt(samples, RATE, 0.1)).toBeNull()
  })

  test('無音からは音程を出さない', () => {
    expect(pitchAt(new Float32Array(RATE), RATE, 0.1)).toBeNull()
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

/**
 * 採譜の e2e (#76)。フィクスチャは Node で書いた WAV -- 既知の時刻に
 * 既知の周波数を置いた 16bit PCM なので、弦・フレット・音価の正解が全部
 * 分かる。ベース単体の録音の理想形であって、実録の揺れはここでは扱わない
 * (それは純関数側の許容の検査が持つ)。
 */
test.describe('音声ファイルからの取り込み', () => {
  test('録音が弦・フレット・音価ごと譜面になる', async ({ page }) => {
    // 0.3 秒格子 (♩=100 の 8 分)。E1 A1 A1 D2 と最後に雑音 1 つ:
    // 目盛 0,2,3,4,6 → ♩ ♪ ♪ ♩、雑音は音程が読めず ♩ の休符になる
    const samples = new Float32Array(Math.round(2.7 * RATE))
    tone(samples, 0.2, 41.203)
    tone(samples, 0.8, 55.0)
    tone(samples, 1.1, 55.0)
    tone(samples, 1.4, 73.416)
    noise(samples, 2.0, 0.15)
    const file = join(asciiFixtureDir(), 'riff.wav')
    writeFileSync(file, wavBytes(samples))

    await openEditor(page)
    await page.setInputFiles('.sidebar input[type="file"]', file)

    const notice = page.locator('.sidebar__notice')
    await expect(notice).toContainText('1 曲を取り込みました')
    await expect(notice).toContainText('1 音は音程が読めず')
    await expect(notice).toContainText('音の長さは音声から推定しました')

    // E1 は開放 E、A1 は最も低いフレット (A 弦開放)、D2 は D 弦開放
    const notes = await page
      .locator('.tab-cell--note')
      .evaluateAll((cells) =>
        cells.map(
          (cell) => (cell.getAttribute('aria-label') ?? '').match(/([GDAE]) 弦/)?.[1] + cell.textContent,
        ),
      )
    expect(notes).toEqual(['E0', 'A0', 'A0', 'D0'])
    await expect(page.locator('.tab-column__rest')).toHaveCount(1)
    expect(await page.locator('.tab-column__value').allTextContents()).toEqual([
      '♩', '♪', '♪', '♩', '♩',
    ])
    // ファイル名が曲名になり、リロードしても残る (保存の検証を通った証拠)
    await page.reload()
    await expect(page.locator('.score-row--current')).toContainText('riff')
  })

  test('読めない音声は理由を出して何も足さない', async ({ page }) => {
    const file = join(asciiFixtureDir(), 'not-audio.wav')
    writeFileSync(file, 'this is not a wav')

    await openEditor(page)
    await page.setInputFiles('.sidebar input[type="file"]', file)

    await expect(page.locator('.sidebar__notice')).toContainText('音声を読めませんでした')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })
})
