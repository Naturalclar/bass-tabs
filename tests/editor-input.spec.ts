import { test, expect, type Page } from '@playwright/test'
import { join } from 'node:path'
import { pdfPageCount, pdfPageSizeMm } from './pdf.ts'
import { asciiFixtureDir, fillFirstMeasure, openEditor } from './helpers.ts'
import { appendRun, moveBeat, place, stepCursor, toggleString, withTime } from '../src/editor/edit.ts'
import { type Entry, type Score, type TimeSignature } from '../src/editor/model.ts'

test('a score entered by clicking renders and prints as A4', async ({ page }) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'E')

  await expect(page.getByRole('status')).toContainText('ページ (A4 縦)')
  await expect(page.locator('svg.score-page')).toHaveCount(1)
  // Canvas would mean the print-quality requirement regressed for edited
  // scores even while imported ones stayed on SVG.
  await expect(page.locator('canvas')).toHaveCount(0)

  const pdf = await page.pdf({ preferCSSPageSize: true })
  expect(pdfPageCount(pdf)).toBe(1)
  const size = pdfPageSizeMm(pdf)
  expect(size.width).toBeCloseTo(210, 0)
  expect(size.height).toBeCloseTo(297, 0)
})

test('the keyboard writes frets, note values and rests', async ({ page }) => {
  await openEditor(page)
  await page.locator('.tab-editor').focus()

  // Two digits in quick succession are one fret number: 12, not 1 then 2.
  await page.keyboard.press('1')
  await page.keyboard.press('2')
  await expect(page.locator('.tab-cell--note')).toHaveText(['12'])

  await page.keyboard.press('e') // eighth notes from here on
  await page.keyboard.press('5')
  await expect(page.locator('.tab-cell--note')).toHaveText(['12', '5'])

  await page.keyboard.press('r')
  await expect(page.locator('.tab-column__rest')).toHaveCount(1)

  await page.keyboard.press('Backspace')
  await expect(page.locator('.tab-column__rest')).toHaveCount(0)

  await expect(page.locator('svg.score-page')).toHaveCount(1)
})

/**
 * `fillFirstMeasure` clicks slots 1..4 in order, which is the one case where
 * the clicked slot and the advancing cursor agree -- so it cannot see a write
 * that lands on the cursor instead of the click. These two go the other way:
 * they click a slot the cursor is not on.
 */
test('clicking an existing column acts on that column, not at the cursor', async ({ page }) => {
  await openEditor(page)
  // Two notes on the E string; the cursor is now past them, at slot 3.
  for (const slot of [1, 2]) {
    await page.getByRole('button', { name: `1 小節目 ${slot} 番目 E 弦` }).click()
  }
  await expect(page.locator('.tab-cell--note')).toHaveCount(2)

  await page.getByRole('button', { name: '1 小節目 1 番目 A 弦' }).click()

  // The A joined the first column as a chord -- at the clicked slot, not at
  // the cursor. Read the lanes off the grid rather than out of storage:
  // which string a note sits on is what the person sees, and the stored
  // shape is free to change.
  await expect(page.locator('.tab-cell--note')).toHaveCount(3)
  const lanes = await page
    .locator('.tab-cell--note')
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute('aria-label')?.match(/(\d+) 番目 ([GDAE]) 弦$/)?.slice(1, 3).join('')),
    )
  expect(lanes).toEqual(['1A', '1E', '2E'])
})

test('clicking a later measure writes into that measure', async ({ page }) => {
  await openEditor(page)
  await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()

  // The cursor is in measure 1; this click is in measure 3.
  await page.getByRole('button', { name: '3 小節目 1 番目 G 弦' }).click()

  const perMeasure = await page.locator('.tab-measure').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelectorAll('.tab-cell--note').length),
  )
  expect(perMeasure).toEqual([1, 0, 1, 0])
})

test('a full measure stops offering a slot to append to', async ({ page }) => {
  await openEditor(page)
  // Three quarters into 4/4: one beat left, so the append slot is still there.
  for (const slot of [1, 2, 3]) {
    await page.getByRole('button', { name: `1 小節目 ${slot} 番目 E 弦` }).click()
  }
  await expect(page.getByText('この小節の残り: 1 拍')).toBeVisible()
  await expect(page.getByRole('button', { name: '1 小節目 4 番目 E 弦' })).toBeVisible()

  await page.getByRole('button', { name: '1 小節目 4 番目 E 弦' }).click()
  await expect(page.getByText('この小節の残り: 0 拍')).toBeVisible()

  // Nothing more fits, so the slot that could only refuse is gone.
  await expect(page.getByRole('button', { name: '1 小節目 5 番目 E 弦' })).toHaveCount(0)
  await expect(page.locator('.tab-measure').first().locator('.tab-column')).toHaveCount(4)
  // The following measures still have theirs.
  await expect(page.getByRole('button', { name: '2 小節目 1 番目 E 弦' })).toBeVisible()
})

test('the highlight stays on the last note of a full measure', async ({ page }) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'E')

  // The cursor sits where the append slot used to be; without a fallback the
  // grid would show no selection at all, and the arrow keys act on the note
  // that selection points at.
  await expect(page.locator('.tab-column--selected')).toHaveCount(1)
  await expect(
    page.locator('.tab-measure').first().locator('.tab-column').last(),
  ).toHaveClass(/tab-column--selected/)

  await page.locator('.tab-editor').focus()
  await page.keyboard.press('ArrowUp')
  await expect(page.locator('.tab-cell--note').last()).toHaveText('1')
})

/**
 * Rewriting an entry changes the length of something already counted, so the
 * append-only question ("does this fit in what is left?") answers it wrongly --
 * the check above passes while a bar quietly grows to seven beats.
 */
test('rewriting an entry cannot overfill the measure either', async ({ page }) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'E')

  // Step back onto the last quarter and try to make it a whole note.
  await page.locator('.tab-editor').focus()
  await page.keyboard.press('ArrowLeft')
  await page.locator('.chip', { hasText: /^全$/ }).click()
  await page.locator('.tab-editor').focus()
  await page.keyboard.press('5')

  await expect(page.getByText('この小節の残り: 0 拍')).toBeVisible()
  await expect(page.locator('.tab-cell--note')).toHaveCount(4)
})

test('a click cannot overfill the measure either', async ({ page }) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'E')

  // Now that a click writes where it lands (#13), it reaches the same path.
  await page.locator('.chip', { hasText: /^2分$/ }).click()
  await page.getByRole('button', { name: '1 小節目 1 番目 G 弦' }).click()

  await expect(page.getByText('この小節の残り: 0 拍')).toBeVisible()
})

/**
 * The remaining-beats readout counts in the meter's own unit. Dividing by
 * DIVISIONS alone is quarter-note arithmetic: right for x/4 metres, and off
 * by half in 6/8, where an empty bar was shown as 残り 3 拍 while six eighth
 * notes still fit.
 */
test('「この小節の残り」は拍子の単位で数える', async ({ page }) => {
  await openEditor(page)
  const remaining = page.locator('.editor-remaining')
  await expect(remaining).toContainText('この小節の残り: 4 拍')

  await page.getByLabel('拍子').selectOption('6/8')
  await expect(remaining).toContainText('この小節の残り: 6 拍')

  await page.locator('.tab-editor').focus()
  await page.keyboard.press('e')
  await page.keyboard.press('5')
  await expect(remaining).toContainText('この小節の残り: 5 拍')
})

/**
 * A beat can be a chord: several strings sounding at once. Clicking builds
 * and unbuilds it -- a lane of an existing column toggles that string in or
 * out -- because clicking two lanes of the same column is the obvious way to
 * ask for a chord, and the same gesture undoes it.
 */
test.describe('和音', () => {
  const cells = (page: Page) =>
    page
      .locator('.tab-cell--note')
      .evaluateAll((all) =>
        all.map(
          (cell) =>
            (cell.getAttribute('aria-label') ?? '').match(/(\d+) 番目 ([GDAE]) 弦$/)?.slice(1, 3).join('') +
            cell.textContent,
        ),
      )

  test('同じ列のレーンをクリックすると和音になり、もう一度で外れる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await page.getByRole('button', { name: '1 小節目 1 番目 G 弦' }).click()
    expect(await cells(page)).toEqual(['1G3', '1E3'])

    // The same gesture takes the string out again.
    await page.getByRole('button', { name: '1 小節目 1 番目 G 弦' }).click()
    expect(await cells(page)).toEqual(['1E3'])

    // Taking out the last string leaves a rest, not a hole: the beat still
    // occupies its time and nothing after it shifts.
    await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()
    expect(await cells(page)).toEqual([])
    await expect(page.locator('.tab-column__rest')).toHaveCount(1)
  })

  test('和音に足した音のフレットを続く数字で直せる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await page.getByRole('button', { name: '1 小節目 1 番目 G 弦' }).click()
    // The digits amend the note the click just added -- the G -- and only it.
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('7')
    expect(await cells(page)).toEqual(['1G7', '1E3'])
  })

  test('矢印キーは和音全体を動かし、動けない音がいれば動かない', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await page.getByRole('button', { name: '1 小節目 1 番目 A 弦' }).click()
    await page.locator('.tab-editor').focus()

    await page.keyboard.press('ArrowUp')
    expect(await cells(page)).toEqual(['1A4', '1E4'])

    // Four halves down would take the E below the open string: the whole
    // chord stays, half a chord never moves.
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown')
    expect(await cells(page)).toEqual(['1A0', '1E0'])
  })

  test('和音は書き出して取り込んでも和音のまま', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('5')
    await page.getByRole('button', { name: '1 小節目 1 番目 D 弦' }).click()

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'MusicXML を書き出す' }).click(),
    ]).then(([event]) => event)
    // Not testInfo.outputPath: the Japanese test title makes that directory
    // non-ASCII, and setInputFiles silently attaches nothing (the trap on
    // asciiFixtureDir in helpers.ts).
    const saved = join(asciiFixtureDir(), 'chord.musicxml')
    await download.saveAs(saved)

    await page.setInputFiles('.sidebar input[type="file"]', saved)
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    expect(await cells(page)).toEqual(['1D5', '1E5'])
  })

  test('和音入りの譜面も A4 で印刷できる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await page.getByRole('button', { name: '1 小節目 1 番目 G 弦' }).click()

    await expect(page.getByRole('status').first()).toContainText('ページ (A4 縦)')
    const pdf = await page.pdf({ preferCSSPageSize: true })
    expect(pdfPageCount(pdf)).toBe(1)
    const size = pdfPageSizeMm(pdf)
    expect(size.width).toBeCloseTo(210, 0)
    expect(size.height).toBeCloseTo(297, 0)
  })

  test('旧形式 (v2) の保存データが和音対応後も読める', async ({ page }) => {
    await openEditor(page)
    // A saved library exactly as version 2 wrote it: single-note entries
    // with string/fret on the entry itself. It must come back as playable
    // notes, not be silently discarded over a field move.
    await page.evaluate(() => {
      localStorage.clear()
      const score = {
        title: '旧形式',
        keyFifths: 0,
        time: { beats: 4, beatType: 4 },
        measures: [
          [
            { kind: 'note', string: 4, fret: 3, value: 4, dotted: false },
            { kind: 'rest', value: 4, dotted: false },
          ],
          [],
        ],
      }
      localStorage.setItem('bass-tabs:score:old-id', JSON.stringify({ version: 2, score }))
      localStorage.setItem(
        'bass-tabs:index',
        JSON.stringify({ version: 2, ids: ['old-id'], currentId: 'old-id' }),
      )
    })
    await page.reload()
    await page.locator('.tab-editor').waitFor()

    await expect(page.locator('.score-row--current')).toContainText('旧形式')
    expect(await cells(page)).toEqual(['1E3'])
    await expect(page.locator('.tab-column__rest')).toHaveCount(1)
  })
})

/**
 * A bar that is full has to hand the keystroke on rather than swallow it:
 * playing a phrase in is one run of keys, and stopping dead at a bar line --
 * with no message and nothing written -- reads as the editor being broken.
 */
/**
 * 3 連符 (#77)。モデルはブラケットを持たず、音符ごとの `triplet` が平らに
 * 並ぶだけ -- グループは書き出しのときに「連続する 3 つ」から導く。だから
 * ここで確かめるのは、長さの算術と排他と、書き出したファイルの形。
 */
test.describe('3 連符', () => {
  test('8 分 3 連 3 つで 4 分 1 つぶんだけ小節が埋まる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('e')
    await page.keyboard.press('t')
    for (const key of ['3', '5', '7']) await page.keyboard.press(key)

    // 4/4 の残りは 4 拍 → 3 拍。ストレートの 8 分 3 つなら 2.5 拍になる。
    await expect(page.locator('.editor-remaining')).toContainText('残り: 3 拍')
    await expect(page.locator('.tab-cell--note')).toHaveText(['3', '5', '7'])
    // 列の表記に 3 連が出る
    await expect(page.locator('.tab-column__value').first()).toHaveText('♪³')
  })

  test('4/4 に 8 分 3 連はちょうど 12 個入り、13 個目は次の小節へ', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('e')
    await page.keyboard.press('t')
    for (let i = 0; i < 12; i++) await page.keyboard.press('0')
    await expect(page.locator('.editor-remaining')).toContainText('残り: 0 拍')

    await page.keyboard.press('0')
    const perBar = await page
      .locator('.tab-measure')
      .evaluateAll((bars) => bars.map((bar) => bar.querySelectorAll('.tab-cell--note').length))
    expect(perBar.slice(0, 2)).toEqual([12, 1])
  })

  test('付点と 3 連は排他', async ({ page }) => {
    await openEditor(page)
    const dot = page.locator('.chip', { hasText: '付点' })
    const triplet = page.locator('.chip', { hasText: '3 連' })

    await page.locator('.tab-editor').focus()
    await page.keyboard.press('.')
    await expect(dot).toHaveAttribute('aria-pressed', 'true')

    await page.keyboard.press('t')
    await expect(triplet).toHaveAttribute('aria-pressed', 'true')
    await expect(dot).toHaveAttribute('aria-pressed', 'false')

    // チップからも同じ: 押した方が入り、もう片方が外れる
    await dot.click()
    await expect(dot).toHaveAttribute('aria-pressed', 'true')
    await expect(triplet).toHaveAttribute('aria-pressed', 'false')
  })

  test('3 連の譜面はリロードしても 3 連のまま', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('e')
    await page.keyboard.press('t')
    for (const key of ['3', '5', '7']) await page.keyboard.press(key)

    await page.reload()
    await page.locator('.tab-editor').waitFor()
    await expect(page.locator('.tab-column__value').first()).toHaveText('♪³')
    await expect(page.locator('.editor-remaining')).toContainText('残り: 3 拍')
  })

  test('旧形式 (v4) の保存データは 3 連なしとして読める', async ({ page }) => {
    await openEditor(page)
    await page.evaluate(() => {
      localStorage.clear()
      const score = {
        title: 'v4 の譜面',
        keyFifths: 0,
        time: { beats: 4, beatType: 4 },
        tempo: 120,
        measures: [[{ kind: 'note', notes: [{ string: 4, fret: 3 }], value: 4, dotted: false }]],
      }
      localStorage.setItem('bass-tabs:score:v4-id', JSON.stringify({ version: 4, score }))
      localStorage.setItem(
        'bass-tabs:index',
        JSON.stringify({ version: 4, ids: ['v4-id'], currentId: 'v4-id' }),
      )
    })
    await page.reload()
    await page.locator('.tab-editor').waitFor()

    await expect(page.locator('.score-row--current')).toContainText('v4 の譜面')
    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])
    await expect(page.locator('.tab-column__value').first()).toHaveText('♩')
  })
})

/**
 * 5 弦ベース (#74)。チューニングは譜面ごとのデータ (`Score.tuning`) で、
 * アプリ全体の設定ではない -- 一覧に 4 弦と 5 弦が同居でき、取り込んだ
 * ファイルは自分の宣言したチューニングを保つ。
 */
test.describe('5 弦', () => {
  const laneLabels = (page: Page) =>
    page
      .locator('.tab-measure')
      .first()
      .locator('.tab-column')
      .first()
      .locator('.tab-cell')
      .evaluateAll((cells) =>
        cells.map((cell) => (cell.getAttribute('aria-label') ?? '').match(/([GDAEB]) 弦$/)?.[1]),
      )

  test('チューニングを変えるとレーンが 5 本になり、B 弦に書ける', async ({ page }) => {
    await openEditor(page)
    expect(await laneLabels(page)).toEqual(['G', 'D', 'A', 'E'])

    await page.getByLabel('チューニング').selectOption('five')
    expect(await laneLabels(page)).toEqual(['G', 'D', 'A', 'E', 'B'])

    await page.getByRole('button', { name: '1 小節目 1 番目 B 弦' }).click()
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    const note = await page
      .locator('.tab-cell--note')
      .evaluateAll((cells) =>
        cells.map(
          (cell) => (cell.getAttribute('aria-label') ?? '').match(/([GDAEB]) 弦$/)?.[1] + cell.textContent,
        ),
      )
    expect(note).toEqual(['B3'])
  })

  test('5 弦の譜面はリロードしても 5 弦のまま', async ({ page }) => {
    await openEditor(page)
    await page.getByLabel('チューニング').selectOption('five')
    await page.getByRole('button', { name: '1 小節目 1 番目 B 弦' }).click()

    await page.reload()
    await page.locator('.tab-editor').waitFor()
    await expect(page.getByLabel('チューニング')).toHaveValue('five')
    expect(await laneLabels(page)).toEqual(['G', 'D', 'A', 'E', 'B'])
  })

  test('4 弦に戻すと B 弦の音は落ちるが、取り消しで戻る', async ({ page }) => {
    await openEditor(page)
    await page.getByLabel('チューニング').selectOption('five')
    await page.getByRole('button', { name: '1 小節目 1 番目 B 弦' }).click()
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)

    // 4 弦に無い弦の音は鳴らせないので落とす。拍は残るので休符になる。
    await page.getByLabel('チューニング').selectOption('four')
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)
    await expect(page.locator('.tab-column__rest')).toHaveCount(1)

    // チューニングの変更も commit() を通る = 取り消しの対象 (#70 と同じ)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByLabel('チューニング')).toHaveValue('five')
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)
  })

  test('Shift+↑ は B 弦から先へは行かない', async ({ page }) => {
    await openEditor(page)
    await page.getByLabel('チューニング').selectOption('five')
    await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('5')

    // E 弦 5f と同じ音は B 弦 10f。4 弦なら端で止まっていた動きが 1 本伸びる。
    await page.keyboard.press('Shift+ArrowDown')
    const moved = await page
      .locator('.tab-cell--note')
      .evaluateAll((cells) =>
        cells.map(
          (cell) => (cell.getAttribute('aria-label') ?? '').match(/([GDAEB]) 弦$/)?.[1] + cell.textContent,
        ),
      )
    expect(moved).toEqual(['B10'])

    // その先は無い
    await page.keyboard.press('Shift+ArrowDown')
    expect(
      await page
        .locator('.tab-cell--note')
        .evaluateAll((cells) =>
          cells.map(
            (cell) => (cell.getAttribute('aria-label') ?? '').match(/([GDAEB]) 弦$/)?.[1] + cell.textContent,
          ),
        ),
    ).toEqual(['B10'])
  })

  test('旧形式 (v5) の保存データは 4 弦として読める', async ({ page }) => {
    await openEditor(page)
    await page.evaluate(() => {
      localStorage.clear()
      const score = {
        title: 'v5 の譜面',
        keyFifths: 0,
        time: { beats: 4, beatType: 4 },
        tempo: 120,
        measures: [
          [{ kind: 'note', notes: [{ string: 4, fret: 3 }], value: 4, dotted: false, triplet: false }],
        ],
      }
      localStorage.setItem('bass-tabs:score:v5-id', JSON.stringify({ version: 5, score }))
      localStorage.setItem(
        'bass-tabs:index',
        JSON.stringify({ version: 5, ids: ['v5-id'], currentId: 'v5-id' }),
      )
    })
    await page.reload()
    await page.locator('.tab-editor').waitFor()

    await expect(page.locator('.score-row--current')).toContainText('v5 の譜面')
    await expect(page.getByLabel('チューニング')).toHaveValue('four')
    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])
  })
})

test.describe('小節をまたぐ入力', () => {
  const perBar = (page: Page) =>
    page
      .locator('.tab-measure')
      .evaluateAll((bars) =>
        bars.map((bar) => [...bar.querySelectorAll('.tab-cell--note')].map((c) => c.textContent)),
      )

  async function setBars(page: Page, count: number) {
    const field = page.getByLabel('小節数')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.pressSequentially(String(count), { delay: 120 })
    await field.blur()
    await expect(page.locator('.tab-measure')).toHaveCount(count)
  }

  test('埋まった小節の続きは次の小節に入る', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    for (let i = 0; i < 4; i++) await page.keyboard.press('3')
    expect((await perBar(page))[0]).toEqual(['3', '3', '3', '3'])

    await page.keyboard.press('1')
    await page.keyboard.press('2')

    // The two digits are still one fret, and they are one fret in the next bar.
    expect((await perBar(page)).slice(0, 2)).toEqual([['3', '3', '3', '3'], ['12']])
  })

  test('最後の小節を超えると小節が増え、取り消しは 1 手で戻る', async ({ page }) => {
    await openEditor(page)
    await setBars(page, 1)
    await page.locator('.tab-editor').focus()
    for (let i = 0; i < 4; i++) await page.keyboard.press('3')
    expect(await perBar(page)).toEqual([['3', '3', '3', '3']])

    await page.keyboard.press('5')
    // The bar that appears holds the note that asked for it -- growing never
    // leaves an empty bar at the end for the user to clean up.
    expect(await perBar(page)).toEqual([['3', '3', '3', '3'], ['5']])

    await page.keyboard.press('ControlOrMeta+z')
    expect(await perBar(page)).toEqual([['3', '3', '3', '3']])
  })

  test('カーソル移動だけでは小節は増えない', async ({ page }) => {
    await openEditor(page)
    await setBars(page, 1)
    await page.locator('.tab-editor').focus()
    for (let i = 0; i < 4; i++) await page.keyboard.press('3')

    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight')

    expect(await perBar(page)).toEqual([['3', '3', '3', '3']])
  })

  test('上限まで来たら止まる', async ({ page }) => {
    await openEditor(page)
    await setBars(page, 64)
    await page.getByRole('button', { name: '64 小節目 1 番目 E 弦' }).click()
    for (const key of ['3', '3', '3', '5']) await page.keyboard.press(key)
    const filled = await perBar(page)
    expect(filled).toHaveLength(64)
    expect(filled[63]).toHaveLength(4)

    // The last bar is full and there is nowhere left to grow into.
    await page.keyboard.press('7')
    const after = await perBar(page)
    expect(after).toHaveLength(64)
    expect(after[63]).toEqual(filled[63])
  })

  test('増えた小節も同じ印刷経路に乗る', async ({ page }) => {
    await openEditor(page)
    await setBars(page, 1)
    await page.locator('.tab-editor').focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('3')
    await expect(page.locator('.tab-measure')).toHaveCount(2)

    await expect(page.locator('svg.score-page')).toHaveCount(1)
    const pdf = await page.pdf({ preferCSSPageSize: true })
    expect(pdfPageCount(pdf)).toBe(1)
    const size = pdfPageSizeMm(pdf)
    expect(size.width).toBeCloseTo(210, 0)
    expect(size.height).toBeCloseTo(297, 0)
  })
})

/**
 * Two digits are one fret only while they name a fret that exists. Clamping
 * "3" then "3" to the top fret was worse than useless: it threw away the note
 * the first digit wrote and ate the second keystroke, so a run of same-digit
 * frets collapsed into a single 24.
 */
test('2 桁にならない数字は次の音になる', async ({ page }) => {
  await openEditor(page)
  await page.locator('.tab-editor').focus()

  for (let i = 0; i < 3; i++) await page.keyboard.press('3')
  await expect(page.locator('.tab-cell--note')).toHaveText(['3', '3', '3'])

  // A run sitting on 0 is the same case: no fret is written "05", so the 7 is
  // its own note -- it does not rewrite the 0 as fret 5.
  await page.keyboard.press('0')
  await page.keyboard.press('7')
  await expect(page.locator('.tab-cell--note')).toHaveText(['3', '3', '3', '0', '7'])
})

/**
 * Undo exists because several edits throw work away with no other way back:
 * lowering the measure count drops whole bars, 新規 drops everything, and a
 * mis-typed fret overwrites what was there.
 */
test.describe('取り消しとやり直し', () => {
  const notesPerBar = (page: Page) =>
    page
      .locator('.tab-measure')
      .evaluateAll((bars) => bars.map((bar) => bar.querySelectorAll('.tab-cell--note').length))

  async function undo(page: Page) {
    await page.keyboard.press('ControlOrMeta+z')
  }

  test('置いた音が Ctrl+Z で消える', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)

    await undo(page)
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)
  })

  test('小節数を減らして取り消すと音ごと戻る', async ({ page }) => {
    await openEditor(page)
    for (const bar of [1, 2, 3, 4]) {
      await page.getByRole('button', { name: `${bar} 小節目 1 番目 E 弦` }).click()
    }

    const field = page.getByLabel('小節数')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.pressSequentially('2')
    await field.press('Enter')
    expect(await notesPerBar(page)).toEqual([1, 1])

    // Out of the field first: inside it, Ctrl+Z belongs to the text input.
    await page.locator('.tab-editor').focus()
    await undo(page)
    expect(await notesPerBar(page)).toEqual([1, 1, 1, 1])
  })

  test('連続した数字入力は 1 回で戻る', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    // "1" then "2" is one note at the 12th fret, so it is one step back.
    await page.keyboard.press('1')
    await page.keyboard.press('2')
    await expect(page.locator('.tab-cell--note')).toHaveText(['12'])

    await undo(page)
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)
  })

  test('曲名の入力は 1 文字ずつ戻らない', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()

    const title = page.getByLabel('曲名')
    await title.click()
    await title.press('ControlOrMeta+a')
    await title.pressSequentially('riff', { delay: 60 })
    await expect(page.getByRole('status')).toContainText('riff')

    await page.locator('.tab-editor').focus()
    await undo(page)

    // One step took the whole word, and the note placed before it survives.
    await expect(page.getByRole('status')).not.toContainText('riff')
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)
  })

  test('曲名の欄では Ctrl+Z が譜面を戻さない', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()

    const title = page.getByLabel('曲名')
    await title.click()
    await title.press('ControlOrMeta+z')

    // The browser owns undo inside a text field; the note stays put.
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)
  })

  test('やり直しで戻した編集が復活する', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()
    await undo(page)
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)

    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)
  })

})

/**
 * The arrows move the note the grid is highlighting: unmodified they change its
 * pitch, with Shift they change which string plays that same pitch.
 */
test.describe('Shift+←→ で小節を移動する', () => {
  const selectedIn = (page: Page, measure: number) =>
    page.locator('.tab-measure').nth(measure).locator('.tab-column--selected')

  test('小節の先頭へ跳び、端では止まる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await page.keyboard.press('5')

    await page.keyboard.press('Shift+ArrowRight')
    // 2 小節目の先頭 (空の小節なので追加スロットが選ばれる)。
    await expect(selectedIn(page, 1)).toHaveCount(1)

    await page.keyboard.press('Shift+ArrowLeft')
    await expect(selectedIn(page, 0).locator('.tab-cell--note')).toHaveText('3')

    // 端: 最初の小節より前、最後の小節より後には行かない。
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(selectedIn(page, 0)).toHaveCount(1)
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
    await expect(selectedIn(page, 3)).toHaveCount(1)
    expect(await page.locator('.tab-measure').count()).toBe(4)
  })

  test('跳んだ先に打った音はその小節に入る', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('7')

    const perBar = await page
      .locator('.tab-measure')
      .evaluateAll((bars) =>
        bars.map((bar) => [...bar.querySelectorAll('.tab-cell--note')].map((c) => c.textContent)),
      )
    expect(perBar.slice(0, 2)).toEqual([['3'], ['7']])
  })
})

test.describe('矢印キーで音を動かす', () => {
  /** Each note as "<string><fret>", e.g. "E5" for the 5th fret of the E string. */
  const notes = (page: Page) =>
    page
      .locator('.tab-cell--note')
      .evaluateAll((cells) =>
        cells.map(
          (cell) =>
            (cell.getAttribute('aria-label') ?? '').match(/([GDAE]) 弦/)?.[1] + cell.textContent,
        ),
      )

  async function noteOnE5(page: Page) {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('5')
    expect(await notes(page)).toEqual(['E5'])
  }

  test('↑↓ が半音ずつ動かす', async ({ page }) => {
    await noteOnE5(page)
    await page.keyboard.press('ArrowUp')
    expect(await notes(page)).toEqual(['E6'])
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    expect(await notes(page)).toEqual(['E4'])
  })

  test('フレットの端では隣の弦へ運ばれる', async ({ page }) => {
    await noteOnE5(page)
    await page.keyboard.press('Shift+ArrowUp')
    expect(await notes(page)).toEqual(['A0'])

    // Below the nut on the A string, so the same pitch moves to the E string.
    await page.keyboard.press('ArrowDown')
    expect(await notes(page)).toEqual(['E4'])
  })

  test('最低音より下げようとしても何も起きない', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('0')
    expect(await notes(page)).toEqual(['E0'])

    await page.keyboard.press('ArrowDown')
    expect(await notes(page)).toEqual(['E0'])
  })

  test('Shift+↑↓ は音を変えずに弦を持ち替える', async ({ page }) => {
    await noteOnE5(page)
    await page.keyboard.press('Shift+ArrowUp')
    expect(await notes(page)).toEqual(['A0'])
    await page.keyboard.press('Shift+ArrowDown')
    expect(await notes(page)).toEqual(['E5'])
  })

  test('その弦で出せない音は持ち替えない', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('0')
    // E1 is below the A string's open note, so there is nowhere to go.
    await page.keyboard.press('Shift+ArrowUp')
    expect(await notes(page)).toEqual(['E0'])
  })

  test('休符は動かない', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('r')
    await expect(page.locator('.tab-column__rest')).toHaveCount(1)

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Shift+ArrowUp')
    await expect(page.locator('.tab-column__rest')).toHaveCount(1)
    expect(await notes(page)).toEqual([])
  })

  test('連続した移動は 1 回で戻る', async ({ page }) => {
    await noteOnE5(page)
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp')
    expect(await notes(page)).toEqual(['E8'])

    await page.keyboard.press('ControlOrMeta+z')
    expect(await notes(page)).toEqual(['E5'])
  })

  test('選択中の音が無ければ Shift+↑↓ は次に置く弦を選ぶ', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()

    // Nothing written yet, so this only moves where the next note will land.
    await page.keyboard.press('Shift+ArrowUp')
    await page.keyboard.press('3')
    expect(await notes(page)).toEqual(['A3'])
  })
})

/**
 * 編集の純関数 (edit.ts)。スコアの変形そのものはここで React 抜きで検査する。
 * フックがこれらを commit に繋いでいることは、上の e2e（クリック・キーボード・
 * 小節をまたぐ入力・和音）が実画面で踏んでいる。
 */
test.describe('編集の純関数', () => {
  const q = (fret: number, string = 4): Entry => ({
    kind: 'note',
    notes: [{ string, fret }],
    value: 4,
    dotted: false,
    triplet: false,
  })
  const scoreOf = (
    measures: Entry[][],
    time: TimeSignature = { beats: 4, beatType: 4 },
  ): Score => ({ title: '', keyFifths: 0, time, tempo: 160, tuning: 'four', measures })

  test('place は埋まった小節から次の空きへ流し、末尾では小節を増やす', () => {
    const full = [q(1), q(1), q(1), q(1)]
    // 2 小節目に空きがある: そこへ流れ、置かれた場所が slot で返る
    const spilled = place(scoreOf([full, [q(2)]]), q(5), { measure: 0, index: 4 })
    expect(spilled?.slot).toEqual({ measure: 1, index: 1 })
    // 空きのある小節が無い: 末尾に小節が増え、増えた小節がその音を持つ
    const grown = place(scoreOf([full]), q(5), { measure: 0, index: 4 })
    expect(grown?.score.measures).toHaveLength(2)
    expect(grown?.slot).toEqual({ measure: 1, index: 0 })
    // すでにある音の打ち替えは流れない: 収まらなければ書かない
    expect(place(scoreOf([full]), { ...q(5), value: 2 }, { measure: 0, index: 0 })).toBeNull()
  })

  test('place は 64 小節を超えて増やさない', () => {
    const whole: Entry = {
      kind: 'note',
      notes: [{ string: 4, fret: 0 }],
      value: 1,
      dotted: false,
      triplet: false,
    }
    const full = scoreOf(Array.from({ length: 64 }, () => [whole]))
    expect(place(full, q(0), { measure: 63, index: 1 })).toBeNull()
  })

  test('toggleString は同じ列の弦を出し入れし、最後の 1 音は休符を残す', () => {
    const one = scoreOf([[q(3, 4)]])
    const added = toggleString(one, { measure: 0, index: 0 }, 3, 5)
    // 追加された運指は弦番号順に並ぶ
    expect(added?.added).toBe(true)
    expect(added?.score.measures[0][0]).toEqual({
      kind: 'note',
      notes: [
        { string: 3, fret: 5 },
        { string: 4, fret: 3 },
      ],
      value: 4,
      dotted: false,
      triplet: false,
    })
    const removed = toggleString(added!.score, { measure: 0, index: 0 }, 3, 0)
    expect(removed?.added).toBe(false)
    // 最後の 1 音を外すと、拍を保ったまま休符が残る
    const rested = toggleString(removed!.score, { measure: 0, index: 0 }, 4, 0)
    expect(rested?.score.measures[0][0]).toEqual({
      kind: 'rest',
      value: 4,
      dotted: false,
      triplet: false,
    })
    // 書かれていない列には toggle するものが無い（呼び出し側が新しく置く）
    expect(toggleString(one, { measure: 0, index: 1 }, 3, 0)).toBeNull()
  })

  test('withTime は縮んだ拍子に収まらない音を末尾から落とす', () => {
    const trimmed = withTime(scoreOf([[q(1), q(2), q(3), q(4)]]), { beats: 3, beatType: 4 })
    expect(trimmed.time).toEqual({ beats: 3, beatType: 4 })
    expect(trimmed.measures[0]).toHaveLength(3)
  })

  test('appendRun は使われた最後の小節から詰め、末尾の空小節を持ち越さない', () => {
    // 空の 2 小節は追記点であって、後ろに残す内容ではない
    const appended = appendRun(scoreOf([[q(1), q(2)], [], []]), [q(3), q(4), q(5)])
    expect(appended.added).toBe(3)
    expect(appended.score.measures).toHaveLength(2)
    expect(appended.score.measures[0]).toHaveLength(4)
    expect(appended.score.measures[1]).toHaveLength(1)
  })

  test('stepCursor は小節線をまたぎ、両端で止まる', () => {
    const score = scoreOf([[q(1)], [q(2)]])
    expect(stepCursor(score, { measure: 0, index: 1 }, 1)).toEqual({ measure: 1, index: 0 })
    expect(stepCursor(score, { measure: 1, index: 0 }, -1)).toEqual({ measure: 0, index: 1 })
    expect(stepCursor(score, { measure: 0, index: 0 }, -1)).toEqual({ measure: 0, index: 0 })
    expect(stepCursor(score, { measure: 1, index: 1 }, 1)).toEqual({ measure: 1, index: 1 })
  })

  test('moveBeat は和音全体を動かし、動けない音が 1 つでもあれば動かさない', () => {
    const chord: Entry = {
      kind: 'note',
      notes: [
        { string: 3, fret: 2 },
        { string: 4, fret: 0 }, // 開放 E: これ以上は下げられない
      ],
      value: 4,
      dotted: false,
      triplet: false,
    }
    expect(moveBeat(scoreOf([[chord]]), { measure: 0, index: 0 }, { semitones: -1 })).toBeNull()
    const up = moveBeat(scoreOf([[chord]]), { measure: 0, index: 0 }, { semitones: 1 })
    expect(up?.landed).toEqual([
      { string: 3, fret: 3 },
      { string: 4, fret: 1 },
    ])
  })
})
