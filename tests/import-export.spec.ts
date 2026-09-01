import { test, expect, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importFile, isTabImage } from '../src/editor/importFile.ts'
import { toBackup } from '../src/editor/backup.ts'
import { DIVISIONS, emptyScore, type Duration, type Entry, type Score } from '../src/editor/model.ts'
import { toMidiFile } from '../src/editor/midiFile.ts'
import { asciiFixtureDir, fillFirstMeasure, openEditor } from './helpers.ts'

/**
 * The scores live only in `localStorage`, so clearing site data or moving
 * machines loses everything. These checks are about the way back.
 */
test.describe('書き出しと取り込み', () => {
  // An ASCII directory, not testInfo.outputPath: see the setInputFiles trap
  // on asciiFixtureDir in helpers.ts.
  const fixtures = asciiFixtureDir()
  const fixture = (name: string, contents: string) => {
    const path = join(fixtures, name)
    writeFileSync(path, contents)
    return path
  }

  async function twoScores(page: Page) {
    await openEditor(page)
    await page.getByLabel('曲名').fill('一曲目')
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('7')

    await page.getByRole('button', { name: '＋ 追加' }).click()
    await expect(page.locator('.score-row').last()).toHaveClass(/score-row--current/)
    await page.getByLabel('曲名').fill('二曲目')
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])
  }

  async function saveDownload(page: Page, button: string, name: string) {
    const event = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: button }).click(),
    ]).then(([download]) => download)
    const path = join(fixtures, name)
    await event.saveAs(path)
    return path
  }

  test('書き出して消して取り込むと全部戻る', async ({ page }) => {
    await twoScores(page)
    const saved = await saveDownload(page, '全部書き出す', 'library.json')

    // The whole point: survive losing the browser's storage.
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expect(page.locator('.score-row')).toHaveCount(1)

    await page.setInputFiles('.sidebar input[type="file"]', saved)

    await expect(page.locator('.sidebar__notice')).toContainText('2 曲を取り込みました')
    const titles = (await page.locator('.score-row__open').allTextContents()).join(' ')
    expect(titles).toContain('一曲目')
    expect(titles).toContain('二曲目')
  })

  test('取り込みは既にある譜面を消さない', async ({ page }) => {
    await twoScores(page)
    const saved = await saveDownload(page, '全部書き出す', 'again.json')

    await page.setInputFiles('.sidebar input[type="file"]', saved)

    // Restoring on top of a library adds to it; nothing already saved is lost.
    await expect(page.locator('.score-row')).toHaveCount(4)
  })

  test('書き出した MusicXML を一覧に取り込める', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('5')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('7')
    await expect(page.locator('.tab-cell--note')).toHaveText(['5', '7'])

    const saved = await saveDownload(page, 'MusicXML を書き出す', 'one.musicxml')
    await page.setInputFiles('.sidebar input[type="file"]', saved)

    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    await expect(page.locator('.score-row')).toHaveCount(2)
    // Read back from the frets, so the written octave cannot confuse it.
    await expect(page.locator('.tab-cell--note')).toHaveText(['5', '7'])
  })

  const REFUSED: { label: string; name: string; contents: string; notice: string }[] = [
    {
      label: '壊れた JSON',
      name: 'broken.json',
      contents: 'not json at all',
      notice: 'ファイルを読めませんでした',
    },
    {
      label: '別形式の JSON',
      name: 'wrong.json',
      contents: '{"format":"something-else","version":1,"scores":[]}',
      notice: 'bass-tabs の書き出しではありません',
    },
    {
      label: '知らない版の JSON',
      name: 'future.json',
      contents: '{"format":"bass-tabs-library","version":99,"scores":[]}',
      notice: '対応していない版',
    },
  ]

  for (const { label, name, contents, notice } of REFUSED) {
    test(`${label}は取り込まず、理由を出す`, async ({ page }) => {
      await openEditor(page)

      await page.setInputFiles('.sidebar input[type="file"]', fixture(name, contents))

      await expect(page.locator('.sidebar__notice')).toContainText(notice)
      // A refused file changes nothing.
      await expect(page.locator('.score-row')).toHaveCount(1)
    })
  }

  /**
   * MusicXML the model cannot hold. Everything here used to slip through:
   * the oversized score saved, said 取り込みました, and then vanished on the
   * next visit when the storage validator refused to read it back; the chord
   * unravelled into sequential beats and overfilled its bar (残り -1 拍), a
   * state the editor itself can never create.
   */
  const tabXml = (measureCount: number, firstMeasureNotes: string) => {
    const note = `<note><pitch><step>E</step><octave>2</octave></pitch><duration>24</duration><type>quarter</type><staff>1</staff><notations><technical><string>4</string><fret>0</fret></technical></notations></note>`
    const measure = (n: number) =>
      `<measure number="${n}">${
        n === 1
          ? `<attributes><divisions>24</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef></attributes>${firstMeasureNotes}`
          : note
      }</measure>`
    return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Bass</part-name></score-part></part-list>
  <part id="P1">${Array.from({ length: measureCount }, (_, i) => measure(i + 1)).join('')}</part>
</score-partwise>`
  }
  const quarterOn = (string: number, fret: number, extra = '') =>
    `<note>${extra}<pitch><step>E</step><octave>2</octave></pitch><duration>24</duration><type>quarter</type><staff>1</staff><notations><technical><string>${string}</string><fret>${fret}</fret></technical></notations></note>`
  /** An eighth note under a <time-modification>: `actual` in the time of 2. */
  const tupletEighth = (fret: number, actual: number) =>
    `<note><pitch><step>E</step><octave>2</octave></pitch><duration>${Math.round((12 * 2) / actual)}</duration><type>eighth</type>` +
    `<time-modification><actual-notes>${actual}</actual-notes><normal-notes>2</normal-notes></time-modification>` +
    `<staff>1</staff><notations><technical><string>4</string><fret>${fret}</fret></technical></notations></note>`

  test('65 小節の MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('too-long.musicxml', tabXml(65, quarterOn(4, 0))),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('小節が多すぎて')
    await expect(page.locator('.score-row')).toHaveCount(1)

    // The old behaviour was worse than a failure: it said 取り込みました and
    // the score then vanished on reload. Nothing may be lost either way.
    await page.reload()
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('64 小節ちょうどはまだ取り込める', async ({ page }) => {
    await openEditor(page)

    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('at-limit.musicxml', tabXml(64, quarterOn(4, 0))),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    await page.reload()
    await expect(page.locator('.score-row')).toHaveCount(2)
  })

  test('和音入りの MusicXML を和音のまま取り込める', async ({ page }) => {
    await openEditor(page)

    // A chord tone rides the previous note's beat: one column, two strings.
    const chord = quarterOn(4, 0) + quarterOn(3, 2, '<chord/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('chord.musicxml', tabXml(1, chord)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    const cells = await page
      .locator('.tab-cell--note')
      .evaluateAll((all) =>
        all.map(
          (cell) =>
            (cell.getAttribute('aria-label') ?? '').match(/(\d+) 番目 ([GDAE]) 弦$/)?.slice(1, 3).join('') +
            cell.textContent,
        ),
      )
    expect(cells).toEqual(['1A2', '1E0'])
  })

  test('同じ弦が 2 回鳴る和音は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    // The one chord the model cannot spell: both tones on the same string.
    const doubled = quarterOn(4, 0) + quarterOn(4, 5, '<chord/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('doubled.musicxml', tabXml(1, doubled)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('タイ・装飾音')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('タイ入りの MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    const tied = quarterOn(4, 0, '<tie type="start"/>') + quarterOn(4, 0, '<tie type="stop"/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('tie.musicxml', tabXml(1, tied)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('タイ・装飾音')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  /**
   * 3 連は #77 まで素通しだった: <time-modification> を見ていないので
   * 「3 連 8 分」が「普通の 8 分」として読まれ、小節に空きさえあれば
   * 黙って違うリズムで取り込まれていた -- このファイル自身が防ぐと
   * 言っている「元と違う譜面」そのもの。
   */
  test('3 連入りの MusicXML を 3 連のまま取り込める', async ({ page }) => {
    await openEditor(page)

    const group = [0, 3, 5].map((fret) => tupletEighth(fret, 3)).join('')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('triplet.musicxml', tabXml(1, group)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    await expect(page.locator('.tab-cell--note')).toHaveText(['0', '3', '5'])
    await expect(page.locator('.tab-column__value').first()).toHaveText('♪³')
    // 3 連として読めていれば 3 つで 1 拍ぶん。ストレートなら 1.5 拍消える。
    await expect(page.locator('.editor-remaining')).toContainText('残り: 3 拍')
  })

  test('半端な 3 連は書き出しのときに 3 連休符で閉じられる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('e')
    await page.keyboard.press('t')
    // 1 つだけ: グループは 3 つそろっていない -- 打ちながらなら必ず通る状態
    await page.keyboard.press('3')

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'MusicXML を書き出す' }).click(),
    ]).then(([event]) => event)
    const saved = join(fixtures, 'partial.musicxml')
    await download.saveAs(saved)
    const xml = readFileSync(saved, 'utf8')

    // 開いたブラケットは閉じていなければならない。閉じ手は 3 連休符で、
    // モデルではなく padded() が足す -- 足りない小節を休符で埋めるのと
    // 同じ流儀。閉じずに書き出すと OSMD は開いたままのブラケットを渡され、
    // 取り込み側でも小節の長さが合わなくなる。
    expect((xml.match(/<tuplet type="start"/g) ?? []).length).toBe(2)
    expect((xml.match(/<tuplet type="stop"/g) ?? []).length).toBe(2)
    // 3 連が 3 つぶん (音 1 + 休符 2) 書かれている: 譜表 2 つで 6
    expect((xml.match(/<actual-notes>3<\/actual-notes>/g) ?? []).length).toBe(6)

    // 閉じたファイルは読み戻せる
    await page.setInputFiles('.sidebar input[type="file"]', saved)
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
  })

  test('5 弦は書き出して取り込んでも 5 弦のまま', async ({ page }) => {
    await openEditor(page)
    await page.getByLabel('チューニング').selectOption('five')
    await page.getByRole('button', { name: '1 小節目 1 番目 B 弦' }).click()

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'MusicXML を書き出す' }).click(),
    ]).then(([event]) => event)
    const saved = join(fixtures, 'five.musicxml')
    await download.saveAs(saved)
    const xml = readFileSync(saved, 'utf8')
    expect(xml).toContain('<staff-lines>5</staff-lines>')
    expect(xml).toContain('<tuning-step>B</tuning-step>')

    await page.setInputFiles('.sidebar input[type="file"]', saved)
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    // 宣言を読んでいる証拠: 5 弦として戻り、B 弦のレーンがある
    await expect(page.getByLabel('チューニング')).toHaveValue('five')
    const lanes = await page
      .locator('.tab-measure')
      .first()
      .locator('.tab-column')
      .first()
      .locator('.tab-cell')
      .count()
    expect(lanes).toBe(5)
  })

  test('持てないチューニングの MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    // 6 弦ギター: 弦番号だけ見れば 1..6 で、4 弦として読むと低音側が全部
    // 範囲外になる。開放弦の音まで見て、持てないものは断る。
    const details =
      '<staff-details number="2" print-object="yes"><staff-lines>6</staff-lines>' +
      ['E:2', 'A:2', 'D:3', 'G:3', 'B:3', 'E:4']
        .map(
          (spec, index) =>
            `<staff-tuning line="${index + 1}"><tuning-step>${spec.split(':')[0]}</tuning-step>` +
            `<tuning-octave>${spec.split(':')[1]}</tuning-octave></staff-tuning>`,
        )
        .join('') +
      '</staff-details>'
    const sixString = tabXml(1, quarterOn(4, 0)).replace('</attributes>', `${details}</attributes>`)
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('six-string.musicxml', sixString),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('タイ・装飾音')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('3 連は書き出して取り込んでも 3 連のまま', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('e')
    await page.keyboard.press('t')
    for (const key of ['3', '5', '7']) await page.keyboard.press(key)

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'MusicXML を書き出す' }).click(),
    ]).then(([event]) => event)
    const saved = join(fixtures, 'roundtrip.musicxml')
    await download.saveAs(saved)

    const xml = readFileSync(saved, 'utf8')
    // ブラケットはモデルではなく書き出しが導く: グループの端だけに付く
    expect(xml).toContain('<actual-notes>3</actual-notes>')
    expect((xml.match(/<tuplet type="start"/g) ?? []).length).toBe(2) // 五線 + TAB
    expect((xml.match(/<tuplet type="stop"/g) ?? []).length).toBe(2)

    await page.setInputFiles('.sidebar input[type="file"]', saved)
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    await expect(page.locator('.tab-cell--note')).toHaveText(['3', '5', '7'])
    // 3 連として読めた証拠はここ: 書き出したファイルは padded() が休符で
    // 閉じた満杯の小節なので残りは 0 拍。ストレートの 8 分として読まれて
    // いれば 3 音で 1.5 拍を食い、残りの休符と合わせて 4.5 拍ぶんになって
    // 小節からあふれ、overfull で取り込み自体が断られる。
    await expect(page.locator('.editor-remaining')).toContainText('残り: 0 拍')
    await expect(page.locator('.tab-column__value').first()).toHaveText('♪³')
  })

  test('3 連以外の連符は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    // 5 連: モデルに表現が無い。素通しさせると別のリズムになる。
    const quintuplet = [0, 3, 5, 7, 9].map((fret) => tupletEighth(fret, 5)).join('')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('quintuplet.musicxml', tabXml(1, quintuplet)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('タイ・装飾音')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('拍子に収まらない小節は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    // Five plain quarter notes in a 4/4 bar: no chord to blame, just too much.
    const five = Array.from({ length: 5 }, () => quarterOn(4, 0)).join('')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('overfull.musicxml', tabXml(1, five)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('拍子に収まらない')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('TAB の無い MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    await page.setInputFiles('.sidebar input[type="file"]', 'public/samples/bass-standard.musicxml')

    await expect(page.locator('.sidebar__notice')).toContainText('TAB 譜が入っていない')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })
})

/**
 * 取り込みファイルの振り分け (importFile.ts)。読み手の断り → 通知文の対応は
 * ここで直接検査する。MusicXML と画像の経路の中身はブラウザが要る (DOMParser /
 * OCR) ので、その通知は既存の e2e（書き出しと取り込み・画像からの取り込み）が
 * 実画面で踏んでいる。
 */
test.describe('取り込みファイルの振り分け', () => {
  const jsonFile = (text: string) => new File([text], 'library.json', { type: 'application/json' })

  test('書き出した JSON はそのまま戻り、曲数を告げる', async () => {
    const text = toBackup([
      { id: 'a', score: emptyScore() },
      { id: 'b', score: emptyScore() },
    ])
    const outcome = await importFile(jsonFile(text))
    expect(outcome.scores).toHaveLength(2)
    expect(outcome.notice).toBe('2 曲を取り込みました')
  })

  test('読めない JSON は理由を告げて、何も足さない', async () => {
    // bass-tabs の書き出しではない JSON
    const wrongFormat = await importFile(jsonFile(JSON.stringify({ hello: 1 })))
    expect(wrongFormat.scores).toHaveLength(0)
    expect(wrongFormat.notice).toBe('この JSON は bass-tabs の書き出しではありません')
    // 版が違う
    const wrongVersion = await importFile(
      jsonFile(JSON.stringify({ format: 'bass-tabs-library', version: 999, scores: [] })),
    )
    expect(wrongVersion.notice).toBe('対応していない版の書き出しです')
    // JSON ですらない
    const broken = await importFile(jsonFile('{'))
    expect(broken.scores).toHaveLength(0)
    expect(broken.notice).toBe('ファイルを読めませんでした')
  })

  test('importFile は投げない: 読み手が爆発しても通知文になる', async () => {
    // text() が失敗するファイル。呼び出し側に catch を書かせないのが約束
    const exploding = { name: 'x.json', text: () => Promise.reject(new Error('boom')) }
    const outcome = await importFile(exploding as unknown as File)
    expect(outcome.scores).toHaveLength(0)
    expect(outcome.notice).toBe('ファイルを読めませんでした: boom')
  })

  test('画像かどうかは拡張子で見分ける', () => {
    expect(isTabImage('tab.png')).toBe(true)
    expect(isTabImage('TAB.JPEG')).toBe(true)
    expect(isTabImage('score.musicxml')).toBe(false)
    expect(isTabImage('library.json')).toBe(false)
  })
})

test('an exported score can be loaded back in', async ({ page }, testInfo) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'A')

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'MusicXML を書き出す' }).click(),
  ]).then(([event]) => event)

  const saved = testInfo.outputPath('exported.musicxml')
  await download.saveAs(saved)

  // Round-trip through the import path: this is what catches MusicXML that
  // renders only because the editor happened to hold it in memory. Picking a
  // file leaves the editor by itself.
  await page.setInputFiles('input[type="file"]', saved)
  await expect(page.getByRole('status')).toContainText('ページ (A4 縦)')
  await expect(page.locator('svg.score-page')).toHaveCount(1)
})

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
