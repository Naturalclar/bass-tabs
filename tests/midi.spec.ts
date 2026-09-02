import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { DIVISIONS, emptyScore, type Duration, type Entry, type Score } from '../src/editor/model.ts'
import { toMidiFile } from '../src/editor/midiFile.ts'
import { fillFirstMeasure, openEditor } from './helpers.ts'

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
