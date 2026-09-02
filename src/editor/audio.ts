/**
 * 音を数値にする側の土台 (#75): PCM からオンセット (発音時刻) を検出し、
 * その列から等間隔の格子 (拍の細分) を推定する。
 *
 * ここは `Float32Array` を受ける純関数だけ。ファイルを PCM にほどくのは
 * Web Audio の仕事で、呼び出し側 (VideoImport) が持つ -- playback.ts と
 * usePlayback.ts の分業と同じ。依存は足さない: OCR は 6MB のエンジンを
 * 持ち込んだが、こちらは素の DSP で書ける規模。
 */

/** 解析フレーム長とホップ (サンプル数)。44.1kHz でホップ ≈ 11.6ms。 */
const FRAME = 1024
const HOP = 512

/** これより近い 2 つの立ち上がりは同じ発音とみなす。 */
const MIN_GAP_SECONDS = 0.08

/**
 * オンセット検出。ベースの発音はエネルギーの立ち上がりとして現れるので、
 * フレームごとの RMS の増分 (負は捨てる) の山を拾う。閾値は近傍の平均に
 * 対する相対値と、全体のピークに対する下限の両方: 前者だけだと無音区間の
 * 微小な揺れが山になり、後者だけだと静かな発音を落とす。
 */
export function onsetTimes(samples: Float32Array, sampleRate: number): number[] {
  const frames = Math.floor((samples.length - FRAME) / HOP) + 1
  if (frames < 3) return []

  const energy = new Float64Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    const at = frame * HOP
    for (let i = 0; i < FRAME; i++) sum += samples[at + i] * samples[at + i]
    energy[frame] = Math.sqrt(sum / FRAME)
  }

  const rise = new Float64Array(frames)
  let peak = 0
  for (let frame = 1; frame < frames; frame++) {
    rise[frame] = Math.max(0, energy[frame] - energy[frame - 1])
    peak = Math.max(peak, rise[frame])
  }
  if (peak <= 0) return []

  const NEIGHBOURHOOD = 10
  const times: number[] = []
  let last = -Infinity
  for (let frame = 1; frame < frames; frame++) {
    const from = Math.max(0, frame - NEIGHBOURHOOD)
    const to = Math.min(frames, frame + NEIGHBOURHOOD + 1)
    let mean = 0
    for (let i = from; i < to; i++) mean += rise[i]
    mean /= to - from

    const isLocalPeak = rise[frame] >= rise[frame - 1] && rise[frame] > (rise[frame + 1] ?? 0)
    const time = (frame * HOP) / sampleRate
    if (isLocalPeak && rise[frame] > mean * 1.5 && rise[frame] > peak * 0.1 && time - last >= MIN_GAP_SECONDS) {
      times.push(time)
      last = time
    }
  }
  return times
}

/** ピッチ探索の範囲 (Hz)。5 弦の低い B (30.9Hz) から G 弦 24 フレットまで。 */
const PITCH_MIN_HZ = 28
const PITCH_MAX_HZ = 450

/** 解析窓。最低音でも 2 周期以上入る長さが要る (30.9Hz の周期は 32ms)。 */
const PITCH_WINDOW_SECONDS = 0.1

/** 発音直後はアタックの雑音なので、少し過ぎてから測る。 */
const ATTACK_SKIP_SECONDS = 0.03

/** CMNDF がこれを下回る谷が無ければ「音程あり」と言わない。 */
const VOICED_THRESHOLD = 0.3

/**
 * この発音のピッチを MIDI ノート番号で返す。取れなければ null -- 休符に
 * して件数を出すのは呼び出し側 (画像取り込みの「読めなかったものは休符」
 * と同じ分業)。
 *
 * 中身は YIN (自己相関の改良): 差分関数の累積平均正規化 (CMNDF) の谷を、
 * 周期の短い側から「十分深い最初の谷」として拾う。ベースは基音が倍音より
 * 弱いことが多く (#76)、スペクトルの最大値を取るとオクターブ上に誤るが、
 * 波形の周期性そのものは基音の周期で残るので、時間領域の谷は騙されにくい。
 * それでも「最初の」谷を優先するのは、倍音だけ強い音で 2 倍周期 (1 オク
 * ターブ下) の谷も同程度に深くなるため -- 短い周期側から見れば真の周期に
 * 先に出会う。
 */
export function pitchAt(samples: Float32Array, sampleRate: number, at: number): number | null {
  const lagMin = Math.floor(sampleRate / PITCH_MAX_HZ)
  const lagMax = Math.ceil(sampleRate / PITCH_MIN_HZ)
  const window = Math.round(PITCH_WINDOW_SECONDS * sampleRate)
  let start = Math.round((at + ATTACK_SKIP_SECONDS) * sampleRate)
  // 音が尻切れなら窓を左へ寄せる。それでも足りなければ測れない。
  start = Math.min(start, samples.length - window - lagMax)
  if (start < 0) return null

  const difference = new Float64Array(lagMax + 1)
  for (let lag = 1; lag <= lagMax; lag++) {
    let sum = 0
    for (let i = 0; i < window; i++) {
      const delta = samples[start + i] - samples[start + i + lag]
      sum += delta * delta
    }
    difference[lag] = sum
  }

  const cmndf = new Float64Array(lagMax + 1)
  cmndf[0] = 1
  let running = 0
  for (let lag = 1; lag <= lagMax; lag++) {
    running += difference[lag]
    cmndf[lag] = running === 0 ? 1 : (difference[lag] * lag) / running
  }

  // 十分深い最初の谷。無ければ最深の谷で妥協し、それでも浅ければ音程なし。
  let lag = -1
  for (let candidate = lagMin; candidate <= lagMax; candidate++) {
    if (cmndf[candidate] < 0.15) {
      while (candidate + 1 <= lagMax && cmndf[candidate + 1] < cmndf[candidate]) candidate++
      lag = candidate
      break
    }
  }
  if (lag === -1) {
    let deepest = Infinity
    for (let candidate = lagMin; candidate <= lagMax; candidate++) {
      if (cmndf[candidate] < deepest) {
        deepest = cmndf[candidate]
        lag = candidate
      }
    }
    if (deepest > VOICED_THRESHOLD) return null
  }

  // 放物線補間で周期をサンプル未満まで詰める。半音は 6% 差なので、低音では
  // 整数ラグだけだと丸めで隣の音に落ちる。
  let period = lag
  if (lag > 1 && lag < lagMax) {
    const left = cmndf[lag - 1]
    const centre = cmndf[lag]
    const right = cmndf[lag + 1]
    const denominator = left + right - 2 * centre
    if (denominator !== 0) period = lag + (left - right) / (2 * denominator)
  }

  const frequency = sampleRate / period
  return Math.round(69 + 12 * Math.log2(frequency / 440))
}

/**
 * オンセット列から推定した格子。`unit` 秒ごとの目盛が `phase` から始まり、
 * 1 目盛は `unitTicks` (DIVISIONS 基準: 16 分 = 6, 8 分 = 12, 4 分 = 24)。
 */
export type Grid = { unit: number; phase: number; unitTicks: number }

/** 音楽としてありうる細分の周期 (秒)。外は倍・半分に畳んで入れる。 */
const UNIT_RANGE = { min: 0.1, max: 0.45 }

/**
 * 間隔が単位の整数倍とみなせる許容ずれ (単位比)。緩めると「どんな列にも
 * 合う細かい単位」が必ず見つかってしまう -- 8 分割まで試す以上、ここが
 * 等間隔とそうでない列を分ける唯一の壁。
 */
const GAP_TOLERANCE = 0.15

/** 最小二乗で磨いたあとの、目盛からの残差の許容 (単位比)。 */
const FIT_TOLERANCE = 0.2

/**
 * オンセットの間隔から最小の共通パルス (細分) を推定する。#11 の段階 3 の
 * 中心。間隔はどれもパルスの整数倍のはずなので、候補 (各間隔の 1/n) を
 * 総当たりし、全間隔が整数倍に最も近く乗る候補を採る。それを最小二乗で
 * 磨き、位相も同時に決める。
 *
 * 乗らないオンセット列 (揺れが大きい、そもそも等間隔でない) は null --
 * 「それらしく見える間違い」を作るくらいなら推定しない。テンポの絶対値は
 * 音だけでは決まらない (0.5 秒間隔は 60 BPM の 8 分でも 120 BPM の 4 分
 * でもある) ので、妥当な BPM 帯に入る解釈を 16 分 → 8 分 → 4 分の順で選ぶ。
 */
export function estimateGrid(onsets: number[]): Grid | null {
  if (onsets.length < 3) return null

  const gaps: number[] = []
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i] - onsets[i - 1])

  // 候補: 各間隔を整数で割って範囲に入れたもの
  const candidates: number[] = []
  for (const gap of gaps) {
    for (let divide = 1; divide <= 8; divide++) {
      const unit = gap / divide
      if (unit >= UNIT_RANGE.min && unit <= UNIT_RANGE.max) candidates.push(unit)
    }
  }
  if (candidates.length === 0) return null

  // 全間隔が整数倍に乗る候補のうち、最も粗い (大きい) 単位を採る。誤差の
  // 小ささで選んではいけない: 細かい単位ほど揺れた列にも「合って」しまう
  // ので、誤差最小は必ず過剰な細分に倒れる。粗い単位が許容内で成立する
  // なら、その細分たちは読み方として冗長なだけ。
  let best: number | null = null
  for (const unit of candidates) {
    if (best !== null && unit <= best) continue
    let ok = true
    for (const gap of gaps) {
      const beats = gap / unit
      if (Math.abs(beats - Math.round(beats)) > GAP_TOLERANCE || Math.round(beats) === 0) {
        ok = false
        break
      }
    }
    if (ok) best = unit
  }
  if (best === null) return null

  // 最小二乗で unit と phase を同時に磨く: t_i ≈ phase + k_i * unit
  let unit = best
  let phase = onsets[0]
  for (let pass = 0; pass < 2; pass++) {
    const ks = onsets.map((t) => Math.round((t - phase) / unit))
    const n = onsets.length
    const sumK = ks.reduce((a, b) => a + b, 0)
    const sumT = onsets.reduce((a, b) => a + b, 0)
    const sumKK = ks.reduce((a, k) => a + k * k, 0)
    const sumKT = ks.reduce((a, k, i) => a + k * onsets[i], 0)
    const denominator = n * sumKK - sumK * sumK
    if (denominator === 0) break
    unit = (n * sumKT - sumK * sumT) / denominator
    phase = (sumT - unit * sumK) / n
  }
  if (!(unit > 0)) return null

  // 検証: 全オンセットが格子に乗り、同じ目盛に 2 つ来ない
  const ks = onsets.map((t) => Math.round((t - phase) / unit))
  for (let i = 0; i < onsets.length; i++) {
    if (Math.abs(onsets[i] - (phase + ks[i] * unit)) > unit * FIT_TOLERANCE) return null
    if (i > 0 && ks[i] <= ks[i - 1]) return null
  }

  // 単位の解釈: 16 分 → 8 分 → 4 分の順で、含意する 4 分音符の BPM が
  // 妥当な帯に入る最初のものを採る
  for (const [unitTicks, perQuarter] of [
    [6, 4],
    [12, 2],
    [24, 1],
  ] as const) {
    const bpm = 60 / (unit * perQuarter)
    if (bpm >= 60 && bpm <= 200) return { unit, phase, unitTicks }
  }
  return null
}
