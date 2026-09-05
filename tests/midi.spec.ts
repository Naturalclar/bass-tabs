import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { DIVISIONS, emptyScore, type Duration, type Entry, type Score } from '../src/editor/model.ts'
import { toMidiFile } from '../src/editor/midiFile.ts'
import { fromMidi } from '../src/editor/midiImport.ts'
import { importFile } from '../src/editor/importFile.ts'
import { schedule } from '../src/editor/playback.ts'
import { isScore } from '../src/editor/storage.ts'
import { asciiFixtureDir, fillFirstMeasure, openEditor } from './helpers.ts'
import { join } from 'node:path'

/**
 * MIDI の書き出し。バイト列は純関数が組み立てるので、ブラウザ抜きでここで
 * 直接検査する（`schedule()` や `edit.ts` と同じ流儀）。
 *
 * 読み返しにはこのファイル用の小さなデコーダを使う。書き出し側のコードを
 * 呼び直すと同じ間違いを追認するだけなので、**別に書いたものでほどく**。
 */
test.describe('MIDI の書き出し', () => {
  const note = (fret: number, string = 4, duration: Partial<Duration> = {}): Entry => ({
    kind: 'note',
    notes: [{ string, fret }],
    value: 4,
    dotted: false,
    triplet: false,
    ...duration,
  })
  const scoreOf = (measures: Entry[][], over: Partial<Score> = {}): Score => ({
    ...emptyScore(),
    measures,
    ...over,
  })

  /** ビッグエンディアンの符号なし整数。 */
  const uint = (b: Uint8Array, at: number, length: number) =>
    b.slice(at, at + length).reduce((n, byte) => n * 256 + byte, 0)
  const ascii = (b: Uint8Array, at: number, length: number) =>
    String.fromCharCode(...b.slice(at, at + length))

  type Decoded = { tick: number; status: number; data: number[] }

  /** トラックの中身を絶対 tick のイベント列にほどく。 */
  function decodeTrack(bytes: Uint8Array): Decoded[] {
    const trackAt = 14
    expect(ascii(bytes, trackAt, 4)).toBe('MTrk')
    const length = uint(bytes, trackAt + 4, 4)
    let at = trackAt + 8
    const end = at + length
    // 宣言された長さが実際の残りと一致すること。SMF で一番ありがちな壊れ方。
    expect(end).toBe(bytes.length)

    const events: Decoded[] = []
    let tick = 0
    while (at < end) {
      let delta = 0
      for (;;) {
        const byte = bytes[at++]
        delta = (delta << 7) | (byte & 0x7f)
        if ((byte & 0x80) === 0) break
      }
      tick += delta
      const status = bytes[at++]
      if (status === 0xff) {
        const kind = bytes[at++]
        let size = 0
        for (;;) {
          const byte = bytes[at++]
          size = (size << 7) | (byte & 0x7f)
          if ((byte & 0x80) === 0) break
        }
        events.push({ tick, status: (0xff << 8) | kind, data: [...bytes.slice(at, at + size)] })
        at += size
      } else if ((status & 0xf0) === 0xc0) {
        events.push({ tick, status, data: [bytes[at++]] })
      } else {
        events.push({ tick, status, data: [bytes[at++], bytes[at++]] })
      }
    }
    return events
  }

  const notesOf = (events: Decoded[], on: boolean) =>
    events.filter((e) => (e.status & 0xf0) === (on ? 0x90 : 0x80))

  test('ヘッダは format 0・1 トラック・division は DIVISIONS', () => {
    const bytes = toMidiFile(scoreOf([[note(0)]]))
    expect(ascii(bytes, 0, 4)).toBe('MThd')
    expect(uint(bytes, 4, 4)).toBe(6)
    expect(uint(bytes, 8, 2)).toBe(0)
    expect(uint(bytes, 10, 2)).toBe(1)
    // ここが DIVISIONS と一致するから、tick が無変換で載る
    expect(uint(bytes, 12, 2)).toBe(DIVISIONS)
  })

  test('テンポと拍子がメタイベントで出る', () => {
    const events = decodeTrack(toMidiFile(scoreOf([[note(0)]], { tempo: 160 })))
    // 60,000,000 / 160 = 375000 マイクロ秒/四分音符
    const tempo = events.find((e) => e.status === 0xff51)
    expect(tempo?.data).toEqual([0x05, 0xb8, 0xd8])
    expect(uint(new Uint8Array(tempo!.data), 0, 3)).toBe(375_000)
    // 4/4 は分母が 2 の指数で 2
    expect(events.find((e) => e.status === 0xff58)?.data).toEqual([4, 2, 24, 8])

    // 6/8 は 3
    const six = decodeTrack(toMidiFile(scoreOf([[note(0)]], { time: { beats: 6, beatType: 8 } })))
    expect(six.find((e) => e.status === 0xff58)?.data).toEqual([6, 3, 24, 8])
  })

  test('割り切れない BPM は丸める', () => {
    const events = decodeTrack(toMidiFile(scoreOf([[note(0)]], { tempo: 90 })))
    // 60,000,000 / 90 = 666666.67
    expect(uint(new Uint8Array(events.find((e) => e.status === 0xff51)!.data), 0, 3)).toBe(666_667)
  })

  // 曲名は UTF-8 で入れている。MIDI 1.0 は text メタの符号化を決めていない
  // ので、latin-1 で読む実装（mido など）では文字化けする — ここが検査して
  // いるのは「意図どおり UTF-8 のバイトが入っていること」であって、どの
  // プレイヤーでも同じに見えることではない。
  test('曲名とベースの音色が入る', () => {
    const events = decodeTrack(toMidiFile(scoreOf([[note(0)]], { title: '無題' })))
    const name = events.find((e) => e.status === 0xff03)
    expect(new TextDecoder().decode(new Uint8Array(name!.data))).toBe('無題')
    // GM 34 Electric Bass (finger) = バイト 33
    expect(events.find((e) => (e.status & 0xf0) === 0xc0)?.data).toEqual([33])
  })

  test('音は実音で、長さは tick のまま出る', () => {
    // 4 弦 5f = A1 (MIDI 33)。記譜の 1 オクターブ上げは musicxml.ts の中だけ
    const events = decodeTrack(toMidiFile(scoreOf([[note(5)]])))
    expect(notesOf(events, true).map((e) => ({ tick: e.tick, midi: e.data[0] }))).toEqual([
      { tick: 0, midi: 33 },
    ])
    expect(notesOf(events, false).map((e) => e.tick)).toEqual([DIVISIONS])
  })

  test('和音は同じ tick の複数の note-on になる', () => {
    const chord: Entry = {
      kind: 'note',
      notes: [
        { string: 3, fret: 2 },
        { string: 4, fret: 0 },
      ],
      value: 4,
      dotted: false,
      triplet: false,
    }
    const on = notesOf(decodeTrack(toMidiFile(scoreOf([[chord]]))), true)
    expect(on.map((e) => e.tick)).toEqual([0, 0])
    expect(on.map((e) => e.data[0]).sort((a, b) => a - b)).toEqual([28, 35])
  })

  test('同じ音が 2 本の弦で鳴る和音は 1 音にまとめる', () => {
    // E 弦 5f と A 弦開放はどちらも A1。譜面としては別々の弦だが、
    // MIDI では同じ高さが重なるので 1 つにする
    const unison: Entry = {
      kind: 'note',
      notes: [
        { string: 3, fret: 0 },
        { string: 4, fret: 5 },
      ],
      value: 4,
      dotted: false,
      triplet: false,
    }
    const events = decodeTrack(toMidiFile(scoreOf([[unison]])))
    expect(notesOf(events, true)).toHaveLength(1)
    expect(notesOf(events, false)).toHaveLength(1)
  })

  test('3 連符は 8 tick で出る', () => {
    const eighth: Partial<Duration> = { value: 8, triplet: true }
    const events = decodeTrack(
      toMidiFile(scoreOf([[note(0, 4, eighth), note(1, 4, eighth), note(2, 4, eighth)]])),
    )
    expect(notesOf(events, true).map((e) => e.tick)).toEqual([0, 8, 16])
    // 3 つで 4 分音符 1 つぶん
    expect(notesOf(events, false).map((e) => e.tick)).toEqual([8, 16, 24])
  })

  test('続けて鳴る同じ音は、note-off が次の note-on より先に出る', () => {
    // 同じ tick に両方来る。順番が逆だと、始まったばかりの音が即座に切れる
    const events = decodeTrack(toMidiFile(scoreOf([[note(0), note(0)]])))
    const atBoundary = events.filter((e) => e.tick === DIVISIONS && (e.status & 0xf0) !== 0xf0)
    expect(atBoundary.map((e) => e.status & 0xf0)).toEqual([0x80, 0x90])
  })

  test('小節は小節線から始まり、長いデルタも書ける', () => {
    // 1 小節目だけ音があり、5 小節目にもう 1 つ。4/4 なので 4*96 = 384 tick 後。
    // 127 を超えるので可変長が 2 バイトになる経路を通る
    const events = decodeTrack(toMidiFile(scoreOf([[note(0)], [], [], [], [note(3)]])))
    expect(notesOf(events, true).map((e) => e.tick)).toEqual([0, 384])
  })

  test('音のない譜面でも壊れたファイルにはならない', () => {
    const events = decodeTrack(toMidiFile(scoreOf([[], [], [], []])))
    expect(notesOf(events, true)).toHaveLength(0)
    expect(events.at(-1)?.status).toBe(0xff2f)
  })

  test('どの譜面でも End of Track で終わる', () => {
    const events = decodeTrack(toMidiFile(scoreOf([[note(0)], [note(7)]])))
    expect(events.at(-1)).toMatchObject({ status: 0xff2f, data: [] })
  })
})

test('書き出した MIDI がダウンロードできる', async ({ page }, testInfo) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'A')

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'MIDI を書き出す' }).click(),
  ]).then(([event]) => event)

  const saved = testInfo.outputPath('exported.mid')
  await download.saveAs(saved)

  // バイナリのまま落ちていること。download ヘルパが文字列しか扱えなかった
  // 頃は、ここで数字が文字として書き出されていた
  const bytes = new Uint8Array(readFileSync(saved))
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd')
  expect(bytes.length).toBeGreaterThan(40)
})

/**
 * MIDI の取り込み。書き出しの逆向きだが同じ難しさではない — ファイルにあるのは
 * 絶対 tick の note-on/off だけで、小節も音価も無い。ここで検査するのは
 * 「格子にぴったり乗るファイルは厳密に戻り、乗らないものは黙って違う譜面に
 * ならずに断られる」こと。
 *
 * 断る側の入力は、書き出し側を通さずにバイト列を直に組む（書き出しが作れない
 * ファイルこそ試したいので）。
 */
test.describe('MIDI の取り込み', () => {
  const vlq = (value: number): number[] => {
    const bytes = [value & 0x7f]
    let rest = value >>> 7
    while (rest > 0) {
      bytes.unshift((rest & 0x7f) | 0x80)
      rest >>>= 7
    }
    return bytes
  }
  const uint32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  /** [delta, ...event] の並びをトラックチャンクにする。End of Track は自動で付く。 */
  const track = (events: number[][]) => {
    const body = events.flatMap(([delta, ...bytes]) => [...vlq(delta), ...bytes])
    body.push(0, 0xff, 0x2f, 0)
    return [0x4d, 0x54, 0x72, 0x6b, ...uint32(body.length), ...body]
  }
  const smf = (division: number, tracks: number[][][]) =>
    new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
      0, tracks.length > 1 ? 1 : 0,
      0, tracks.length,
      (division >> 8) & 0xff, division & 0xff,
      ...tracks.flatMap(track),
    ])
  const on = (delta: number, midi: number) => [delta, 0x90, midi, 100]
  const off = (delta: number, midi: number) => [delta, 0x80, midi, 0]

  const entry = (
    fingerings: { string: number; fret: number }[],
    value: Entry['value'],
    extra: Partial<Duration> = {},
  ): Entry => ({ kind: 'note', notes: fingerings, value, dotted: false, triplet: false, ...extra })
  const rest = (value: Entry['value'], extra: Partial<Duration> = {}): Entry => ({
    kind: 'rest',
    value,
    dotted: false,
    triplet: false,
    ...extra,
  })

  test('自分の書き出しは音・長さ・テンポ・拍子がそのまま戻る', () => {
    // 運指は positionFor が選ぶもの（いちばん高い弦）で書いておく。そうすると
    // 取り込み後の譜面が**丸ごと**一致するはずで、比較を最も厳しくできる
    const original: Score = {
      ...emptyScore(),
      title: '往復',
      tempo: 90,
      measures: [
        [
          // E1 + B1 の和音
          entry([{ string: 3, fret: 2 }, { string: 4, fret: 0 }], 4),
          entry([{ string: 4, fret: 3 }], 4, { dotted: true }),
          rest(8),
          entry([{ string: 3, fret: 0 }], 8, { triplet: true }),
          rest(8, { triplet: true }),
          entry([{ string: 3, fret: 2 }], 8, { triplet: true }),
        ],
        [rest(2), entry([{ string: 2, fret: 0 }], 2)],
        [
          entry([{ string: 1, fret: 7 }], 16),
          rest(8, { dotted: true }),
          entry([{ string: 1, fret: 0 }], 4),
          entry([{ string: 3, fret: 0 }], 2),
        ],
      ],
    }
    const result = fromMidi(toMidiFile(original), 'ignored')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dropped).toBe(0)
    expect(result.score).toEqual(original)
    expect(isScore(result.score)).toBe(true)
    // 再生で鳴るものも同じ
    expect(schedule(result.score)).toEqual(schedule(original))
  })

  test('6/8 でも小節の切り方が拍子に従う', () => {
    const original: Score = {
      ...emptyScore(),
      time: { beats: 6, beatType: 8 },
      measures: [
        [entry([{ string: 4, fret: 0 }], 4, { dotted: true }), rest(4, { dotted: true })],
        [rest(4, { dotted: true }), entry([{ string: 4, fret: 2 }], 4, { dotted: true })],
      ],
    }
    const result = fromMidi(toMidiFile(original), 'x')
    expect(result.ok && result.score.time).toEqual({ beats: 6, beatType: 8 })
    expect(result.ok && result.score.measures).toEqual(original.measures)
  })

  test('3 連の直後の休符はその 3 連の値で埋まり、括弧が閉じる', () => {
    // 16 tick の隙間は 3 連 4 分休符 1 つでも書けるが、8 分 3 連の後ろなら
    // 8 分 3 連休符 2 つで 1 組にする
    const original: Score = {
      ...emptyScore(),
      measures: [
        [
          entry([{ string: 3, fret: 0 }], 8, { triplet: true }),
          rest(8, { triplet: true }),
          rest(8, { triplet: true }),
          entry([{ string: 3, fret: 2 }], 4),
          entry([{ string: 3, fret: 3 }], 2),
        ],
        // 小節の末尾でも同じ
        [
          entry([{ string: 3, fret: 0 }], 2),
          entry([{ string: 3, fret: 0 }], 4),
          entry([{ string: 3, fret: 0 }], 8, { triplet: true }),
          rest(8, { triplet: true }),
          rest(8, { triplet: true }),
        ],
      ],
    }
    const result = fromMidi(toMidiFile(original), 'x')
    expect(result.ok && result.score.measures).toEqual(original.measures)
  })

  test('E1 より下の音があれば 5 弦として取り込む', () => {
    const five: Score = {
      ...emptyScore(),
      tuning: 'five',
      measures: [[entry([{ string: 5, fret: 0 }], 4), entry([{ string: 4, fret: 0 }], 2), rest(4)]],
    }
    const result = fromMidi(toMidiFile(five), 'x')
    expect(result.ok && result.dropped).toBe(0)
    expect(result.ok && result.score).toEqual(five)
    // B0 より下はどちらでも届かないので落ちる。A0 (21) 単独: 4 弦のまま、休符
    const low = fromMidi(smf(24, [[on(0, 21), off(24, 21)]]), 'x')
    expect(low.ok && low.dropped).toBe(1)
    expect(low.ok && low.score.tuning).toBe('four')
    expect(low.ok && low.score.measures[0][0]).toEqual(rest(4))
  })

  test('DAW の division (480) でも格子に乗っていれば読める', () => {
    const bytes = smf(480, [[on(0, 33), off(480, 33), on(0, 35), off(240, 35)]])
    const result = fromMidi(bytes, 'daw')
    expect(result.ok && result.score.measures).toEqual([
      [
        entry([{ string: 3, fret: 0 }], 4),
        entry([{ string: 3, fret: 2 }], 8),
        // 残りは休符で小節線まで埋まる: 8 分 + 2 分
        rest(2),
        rest(8),
      ],
    ])
  })

  test('格子に乗らない音は断る（量子化はしない）', () => {
    // 490/480 四分音符 = 24.5 tick
    expect(fromMidi(smf(480, [[on(0, 33), off(490, 33)]]), 'x')).toEqual({
      ok: false,
      reason: 'off-grid',
    })
  })

  test('小節線をまたぐ音・重なった音・32 分は断る', () => {
    // 4/4 の 4 拍目から 2 分音符: 次の小節に食い込む
    expect(fromMidi(smf(24, [[on(72, 33), off(48, 33)]]), 'x')).toMatchObject({
      reason: 'unsupported',
    })
    // A を鳴らしたまま B が始まる
    expect(fromMidi(smf(24, [[on(0, 33), on(12, 35), off(12, 33), off(12, 35)]]), 'x')).toMatchObject({
      reason: 'unsupported',
    })
    // 3 tick = 32 分音符
    expect(fromMidi(smf(24, [[on(0, 33), off(3, 33)]]), 'x')).toMatchObject({
      reason: 'unsupported',
    })
    // 和音の 2 音が別々の長さ: 1 拍 1 音価に収まらない
    expect(fromMidi(smf(24, [[on(0, 33), on(0, 40), off(12, 33), off(12, 40)]]), 'x')).toMatchObject({
      reason: 'unsupported',
    })
  })

  test('隙間は最少の休符で埋め、同数なら 3 連でないほうを選ぶ', () => {
    // 20 tick は 8 分 + 3 連 8 分（3 連 4 分 + 3 連 16 分でもあるが）
    const result = fromMidi(smf(24, [[on(20, 33), off(24, 33)]]), 'x')
    expect(result.ok && result.score.measures[0].slice(0, 3)).toEqual([
      rest(8),
      rest(8, { triplet: true }),
      entry([{ string: 3, fret: 0 }], 4),
    ])
  })

  test('和音の各音が別々の弦に乗る', () => {
    // D2 + E2: 単音ごとに positionFor を引くとどちらも D 弦になる（issue の実測）
    const result = fromMidi(smf(24, [[on(0, 38), on(0, 40), off(24, 38), off(0, 40)]]), 'x')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.score.measures[0][0]).toEqual(
      entry([{ string: 2, fret: 2 }, { string: 3, fret: 5 }], 4),
    )
    // 保存の検証を通ること — 同じ弦が 2 回鳴る譜面は保存できない
    expect(isScore(result.score)).toBe(true)
  })

  test('音域外の音は落として数える。全部落ちれば休符', () => {
    // C0 (12) は E1 の下。単独なら休符、和音なら残りの音だけ
    const alone = fromMidi(smf(24, [[on(0, 12), off(24, 12)]]), 'x')
    expect(alone.ok && alone.dropped).toBe(1)
    expect(alone.ok && alone.score.measures[0][0]).toEqual(rest(4))

    const chord = fromMidi(smf(24, [[on(0, 12), on(0, 28), off(24, 12), off(0, 28)]]), 'x')
    expect(chord.ok && chord.dropped).toBe(1)
    expect(chord.ok && chord.score.measures[0][0]).toEqual(entry([{ string: 4, fret: 0 }], 4))
  })

  test('テンポ・拍子・調・曲名はメタから読む。音のないトラックにあってもよい', () => {
    const meta = [
      [0, 0xff, 0x03, 3, 0x41, 0x42, 0x43], // "ABC"
      [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], // 500000 µs = 120 BPM
      [0, 0xff, 0x58, 4, 3, 2, 24, 8], // 3/4
      [0, 0xff, 0x59, 2, 0xfe, 0], // 2 flats
    ]
    const result = fromMidi(smf(24, [meta, [on(0, 33), off(72, 33)]]), 'fallback')
    expect(result.ok && result.score).toMatchObject({
      title: 'ABC',
      tempo: 120,
      time: { beats: 3, beatType: 4 },
      keyFifths: -2,
      measures: [[entry([{ string: 3, fret: 0 }], 2, { dotted: true })]],
    })
    // メタが無ければ既定値とファイル名
    const bare = fromMidi(smf(24, [[on(0, 33), off(24, 33)]]), 'fallback')
    expect(bare.ok && bare.score).toMatchObject({ title: 'fallback', tempo: 160, keyFifths: 0 })
  })

  test('ランニングステータスと velocity 0 の note-off を読む', () => {
    const bytes = smf(24, [[[0, 0x90, 33, 100], [24, 33, 0], [0, 35, 100], [24, 35, 0]]])
    const result = fromMidi(bytes, 'x')
    expect(result.ok && result.score.measures[0].slice(0, 2)).toEqual([
      entry([{ string: 3, fret: 0 }], 4),
      entry([{ string: 3, fret: 2 }], 4),
    ])
  })

  test('SMPTE・複数トラック・音なし・65 小節以上・壊れたファイルは理由つきで断る', () => {
    // 負の division はタイムコード基準
    expect(fromMidi(smf(0xe728, [[on(0, 33), off(24, 33)]]), 'x')).toEqual({
      ok: false,
      reason: 'smpte',
    })
    expect(
      fromMidi(smf(24, [[on(0, 33), off(24, 33)], [on(0, 40), off(24, 40)]]), 'x'),
    ).toEqual({ ok: false, reason: 'multi-track' })
    expect(fromMidi(smf(24, [[[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]]]), 'x')).toEqual({
      ok: false,
      reason: 'no-notes',
    })
    // 65 小節目の頭 = 64 * 96 tick
    expect(fromMidi(smf(24, [[on(64 * 96, 33), off(24, 33)]]), 'x')).toEqual({
      ok: false,
      reason: 'too-long',
    })
    expect(fromMidi(new Uint8Array([1, 2, 3]), 'x')).toEqual({ ok: false, reason: 'unreadable' })
    expect(fromMidi(new Uint8Array(), 'x')).toEqual({ ok: false, reason: 'unreadable' })
    // ヘッダは正しいがトラックが途中で切れている
    const cut = smf(24, [[on(0, 33), off(24, 33)]]).slice(0, 20)
    expect(fromMidi(cut, 'x')).toEqual({ ok: false, reason: 'unreadable' })
  })

  test('importFile は .mid をバイナリとして振り分け、理由を通知文にする', async () => {
    const midi = (bytes: Uint8Array<ArrayBuffer>, name = 'song.mid') =>
      new File([bytes], name, { type: 'audio/midi' })
    const ok = await importFile(midi(smf(24, [[on(0, 33), off(24, 33)]])))
    expect(ok.scores).toHaveLength(1)
    expect(ok.scores[0].title).toBe('song')
    expect(ok.notice).toContain('1 曲を取り込みました')

    const dropped = await importFile(midi(smf(24, [[on(0, 12), off(24, 12)]]), 'low.MIDI'))
    expect(dropped.scores).toHaveLength(1)
    expect(dropped.notice).toContain('1 音')

    const offGrid = await importFile(midi(smf(480, [[on(0, 33), off(490, 33)]])))
    expect(offGrid.scores).toHaveLength(0)
    expect(offGrid.notice).toContain('格子')

    const broken = await importFile(midi(new Uint8Array([1, 2, 3])))
    expect(broken.scores).toHaveLength(0)
    expect(broken.notice).toContain('MIDI')
  })
})

test('書き出した MIDI を一覧に取り込める', async ({ page }) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'A')
  await page.getByLabel('曲名').fill('戻ってくる')

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'MIDI を書き出す' }).click(),
  ]).then(([event]) => event)
  // ASCII なディレクトリに置く: helpers.ts の asciiFixtureDir を見よ
  const saved = join(asciiFixtureDir(), 'back.mid')
  await download.saveAs(saved)

  await page.setInputFiles('.sidebar input[type="file"]', saved)

  await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
  await expect(page.locator('.score-row')).toHaveCount(2)
  // 取り込んだ譜面が開き、A 弦開放 4 つが戻っている
  await expect(page.getByLabel('曲名')).toHaveValue('戻ってくる')
  await expect(page.locator('.tab-cell--note')).toHaveText(['0', '0', '0', '0'])
})
