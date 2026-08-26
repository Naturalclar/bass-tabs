import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { columnAt, schedule, secondsPerTick, ticksAt } from '../src/editor/playback.ts'
import {
  DIVISIONS,
  type Entry,
  type NoteValue,
  type Score,
  type TimeSignature,
} from '../src/editor/model.ts'
import { asciiFixtureDir, fillFirstMeasure, openEditor } from './helpers.ts'

/**
 * テンポは譜面の一部 (#65): 紙に ♩=N と刷られ、ファイルに乗り、取り消しの
 * 対象になる。再生専用の状態だった頃の性質 (リロードで消える) が残って
 * いないことをここで固定する。
 */
test.describe('テンポ', () => {
  test('既定は 160 で、楽譜の上に ♩=160 が刷られる', async ({ page }) => {
    await openEditor(page)
    await expect(page.getByLabel('BPM')).toHaveValue('160')

    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await expect(page.getByRole('status').first()).toContainText('ページ (A4 縦)')
    const texts = await page.locator('svg.score-page text').allTextContents()
    expect(texts.join(' ')).toContain('= 160')
  })

  test('変更は保存され、1 手で取り消せる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')

    const field = page.getByLabel('BPM')
    await field.fill('100')
    await page.waitForFunction(() =>
      [...document.querySelectorAll('svg.score-page text')].some((t) =>
        t.textContent?.includes('= 100'),
      ),
    )

    // 100 への調整はまとめて 1 手: 一回の取り消しで 160 に戻る。
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByLabel('BPM')).toHaveValue('160')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(field).toHaveValue('100')

    // 再生専用の状態だった頃はここで 160 に戻っていた: テンポは保存される。
    // (履歴は保存しないので、リロード後の取り消しまでは求めない)
    await page.reload()
    await page.locator('.tab-editor').waitFor()
    await expect(page.getByLabel('BPM')).toHaveValue('100')
  })

  test('書き出した MusicXML にテンポが乗り、取り込みで戻る', async ({ page }) => {
    await openEditor(page)
    await page.getByLabel('BPM').fill('132')
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('5')

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'MusicXML を書き出す' }).click(),
    ]).then(([event]) => event)
    const saved = join(asciiFixtureDir(), 'tempo.musicxml')
    await download.saveAs(saved)
    const xml = readFileSync(saved, 'utf8')
    expect(xml).toContain('<per-minute>132</per-minute>')
    expect(xml).toContain('<sound tempo="132"/>')

    await page.setInputFiles('.sidebar input[type="file"]', saved)
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    await expect(page.getByLabel('BPM')).toHaveValue('132')
  })

  test('テンポの無い保存データ (v3) は 160 で読める', async ({ page }) => {
    await openEditor(page)
    await page.evaluate(() => {
      localStorage.clear()
      const score = {
        title: 'テンポ無し',
        keyFifths: 0,
        time: { beats: 4, beatType: 4 },
        measures: [[{ kind: 'note', notes: [{ string: 4, fret: 3 }], value: 4, dotted: false }]],
      }
      localStorage.setItem('bass-tabs:score:v3-id', JSON.stringify({ version: 3, score }))
      localStorage.setItem(
        'bass-tabs:index',
        JSON.stringify({ version: 3, ids: ['v3-id'], currentId: 'v3-id' }),
      )
    })
    await page.reload()
    await page.locator('.tab-editor').waitFor()

    await expect(page.locator('.score-row--current')).toContainText('テンポ無し')
    await expect(page.getByLabel('BPM')).toHaveValue('160')
    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])
  })

  test('再生ボタンはアイコンでも名前で見つかる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    // 表示はアイコンだが、アクセシブルネームは「再生」のまま -- e2e も
    // スクリーンリーダーもこの名前に依存している。
    const play = page.getByRole('button', { name: '再生', exact: true })
    await expect(play).toBeEnabled()
    await expect(play.locator('svg')).toHaveCount(1)
  })
})

/**
 * 再生のスケジュールは純関数なので、ブラウザ抜きでここで検査する。ヘッドレスでは
 * 音そのものは聞けないため、時刻と長さの計算がこの機能の検査可能なすべてになる。
 */
test.describe('再生のスケジュール', () => {
  const quarter = DIVISIONS

  const note = (fret: number, value: NoteValue = 4, dotted = false): Entry => ({
    kind: 'note',
    notes: [{ string: 4, fret }],
    value,
    dotted,
  })
  const rest = (value: NoteValue = 4): Entry => ({ kind: 'rest', value, dotted: false })
  const scoreOf = (
    measures: Entry[][],
    time: TimeSignature = { beats: 4, beatType: 4 },
  ): Score => ({ title: '', keyFifths: 0, time, tempo: 160, measures })

  test('columnAt と ticksAt は互いの逆で、書きかけの小節の尻は null', () => {
    const score = scoreOf([[note(0), note(2)], [note(5)]])
    // 各列の開始 tick に対して columnAt が同じ列を返す
    for (const at of [
      { measure: 0, index: 0 },
      { measure: 0, index: 1 },
      { measure: 1, index: 0 },
    ]) {
      expect(columnAt(score, ticksAt(score, at))).toEqual(at)
    }
    // 1 小節目の 3 拍目以降は何も書かれていない: 静かな尻は列を持たない
    expect(columnAt(score, quarter * 2)).toBeNull()
    // 列の途中の tick はその列のまま
    expect(columnAt(score, quarter / 2)).toEqual({ measure: 0, index: 0 })
  })

  test('和音は同じ時刻に全部鳴る', () => {
    const chord: Entry = {
      kind: 'note',
      notes: [
        { string: 4, fret: 0 },
        { string: 3, fret: 2 },
      ],
      value: 4,
      dotted: false,
    }
    const notes = schedule(scoreOf([[chord, note(3)]]))
    expect(notes).toEqual([
      { midi: 28, startTicks: 0, durationTicks: quarter },
      { midi: 35, startTicks: 0, durationTicks: quarter },
      { midi: 31, startTicks: quarter, durationTicks: quarter },
    ])
  })

  test('音は実音で鳴り、休符は時間だけ進める', () => {
    const notes = schedule(scoreOf([[note(0), rest(), note(2)]]))
    // 開放 E は E1 (MIDI 28)。記譜は 1 オクターブ上だが、それは musicxml.ts の
    // 中だけの話で、鳴らす高さは弾く高さのまま。
    expect(notes).toEqual([
      { midi: 28, startTicks: 0, durationTicks: quarter },
      { midi: 30, startTicks: quarter * 2, durationTicks: quarter },
    ])
  })

  test('和音は全部の弦が同じ開始時刻で鳴る', () => {
    const chord: Entry = {
      kind: 'note',
      notes: [
        { string: 3, fret: 2 }, // A 弦 2f = B1 (MIDI 35)
        { string: 4, fret: 0 }, // 開放 E = E1 (MIDI 28)
      ],
      value: 4,
      dotted: false,
    }
    const notes = schedule(scoreOf([[chord]]))
    expect(notes).toEqual([
      { midi: 35, startTicks: 0, durationTicks: quarter },
      { midi: 28, startTicks: 0, durationTicks: quarter },
    ])
  })

  test('付点は 1.5 倍の長さを取る', () => {
    const notes = schedule(scoreOf([[note(0, 8, true), note(0, 16)]]))
    // 付点 8 分 = 18 tick。DIVISIONS が 24 なのは付点 16 分 (9) までを整数に保つため
    expect(notes[0].durationTicks).toBe(18)
    expect(notes[1].startTicks).toBe(18)
  })

  test('小節は小節線から始まる — 書きかけの小節の残りは無音', () => {
    // 1 小節目は 4 分音符 1 つだけ。2 小節目の音は 1 拍後ではなく小節線から。
    const notes = schedule(scoreOf([[note(0)], [note(5)]]))
    expect(notes[1].startTicks).toBe(quarter * 4)
  })

  test('6/8 では小節線の位置がそれに合わせて動く', () => {
    const eighth = DIVISIONS / 2
    const notes = schedule(scoreOf([[note(0, 8)], [note(0, 8)]], { beats: 6, beatType: 8 }))
    expect(notes[1].startTicks).toBe(eighth * 6)
  })

  test('BPM は 4 分音符の数で、範囲外は丸める', () => {
    // 60 BPM なら 4 分音符 (DIVISIONS tick) がちょうど 1 秒
    expect(secondsPerTick(60) * DIVISIONS).toBeCloseTo(1)
    expect(secondsPerTick(0)).toBe(secondsPerTick(30))
  })
})

/**
 * ヘッドレスでは音が出ていることは検査できないので、e2e はボタンの状態遷移が
 * 壊れていないことだけを見る煙テスト。鳴らす中身は上の純関数の検査が持つ。
 */
/**
 * 追従系はスコープ転換 (#66, #67) で対象になった: いま鳴っている列が
 * タブ譜の上で光り、小節番号のクリックがその小節からの再生になる。
 * 追従はアプリ自身のグリッドで行い、OSMD のページには触らない --
 * ページは印刷プレビューのまま。
 */
test.describe('追従と頭出し', () => {
  test('小節番号のクリックでその小節から鳴り、いまの列が光る', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    // 1 小節目は 30 BPM の全音符 = 8 秒。頭出しが効いていなければ、この
    // 検査のタイムアウト (5 秒) 内に 2 小節目へ到達できない -- 到達を
    // 待つ自動リトライで頭出しの欠如が隠れないようにするための長さ。
    await page.keyboard.press('w')
    await page.keyboard.press('3')
    await page.keyboard.press('q')
    await page.keyboard.press('5')
    await page.keyboard.press('5')
    await page.getByLabel('BPM').fill('30')

    await page.getByRole('button', { name: '2 小節目から再生' }).click()
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible()

    // 光るのは 2 小節目の列: 頭出しが効いていて、1 小節目は飛ばされた
    await expect(page.locator('.tab-measure').nth(1).locator('.tab-column--playing')).toHaveCount(1)
    await expect(page.locator('.tab-measure').nth(0).locator('.tab-column--playing')).toHaveCount(0)

    await page.getByRole('button', { name: '停止' }).click()
    await expect(page.locator('.tab-column--playing')).toHaveCount(0)
  })

  test('再生が進むとハイライトが次の列へ動く', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    for (const key of ['3', '5', '7']) await page.keyboard.press(key)
    // 60 BPM の 4 分音符 = 1 拍 1 秒: 1.2 秒後には 2 列目にいる
    await page.getByLabel('BPM').fill('60')
    await page.getByRole('button', { name: '1 小節目から再生' }).click()

    const playingIndex = () =>
      page
        .locator('.tab-measure')
        .first()
        .locator('.tab-column')
        .evaluateAll((columns) =>
          columns.findIndex((column) => column.classList.contains('tab-column--playing')),
        )
    await expect
      .poll(playingIndex, { timeout: 3000 })
      .toBeGreaterThan(0)

    await page.getByRole('button', { name: '停止' }).click()
  })

  test('再生中に別の小節番号を押すとそこへ跳ぶ', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    for (const key of ['3', '3', '3', '3', '5', '5', '5', '5']) await page.keyboard.press(key)
    await page.getByLabel('BPM').fill('30')

    await page.getByRole('button', { name: '1 小節目から再生' }).click()
    await expect(page.locator('.tab-measure').nth(0).locator('.tab-column--playing')).toHaveCount(1)

    await page.getByRole('button', { name: '2 小節目から再生' }).click()
    await expect(page.locator('.tab-measure').nth(1).locator('.tab-column--playing')).toHaveCount(1)
    await expect(page.locator('.tab-measure').nth(0).locator('.tab-column--playing')).toHaveCount(0)

    await page.getByRole('button', { name: '停止' }).click()
  })
})

test.describe('再生', () => {
  test('空の譜面は再生できず、音を置くと再生 → 停止で戻る', async ({ page }) => {
    await openEditor(page)
    const play = page.getByRole('button', { name: '再生', exact: true })
    await expect(play).toBeDisabled()

    await fillFirstMeasure(page, 'E')
    await expect(play).toBeEnabled()

    // 遅くして、検査が押すより先に再生が終わってしまわないようにする
    await page.getByLabel('BPM').fill('30')
    await play.click()
    const stop = page.getByRole('button', { name: '停止' })
    await expect(stop).toBeVisible()

    await stop.click()
    await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled()
  })

  test('譜面を切り替えると再生は止まる', async ({ page }) => {
    await openEditor(page)
    await fillFirstMeasure(page, 'E')
    await page.getByLabel('BPM').fill('30')
    await page.getByRole('button', { name: '再生', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible()

    await page.getByRole('button', { name: '＋ 追加' }).click()

    // 新しい譜面は空なので、再生は止まり、鳴らすものも無い
    const play = page.getByRole('button', { name: '再生', exact: true })
    await expect(play).toBeVisible()
    await expect(play).toBeDisabled()
  })
})
