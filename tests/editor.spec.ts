import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_PATH } from '../base-path.ts'
import { pdfPageCount, pdfPageSizeMm } from './pdf.ts'

/**
 * The editor's whole point is that its output goes through the same path as an
 * imported file, so these checks end where the import checks end: at the PDF.
 * Rendering in the browser is not enough -- MusicXML that OSMD draws on screen
 * can still paginate wrongly, and printing is what this app is for.
 */




async function openEditor(page: Page) {
  await page.goto(BASE_PATH)
  await page.getByRole('button', { name: '譜面を作る' }).click()
}

/** Fills measure 1 with four quarter notes on the given string. */
async function fillFirstMeasure(page: Page, stringLabel: string) {
  for (let i = 1; i <= 4; i++) {
    await page.getByRole('button', { name: `1 小節目 ${i} 番目 ${stringLabel} 弦` }).click()
  }
}

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
test('clicking an existing note writes at that note, not at the cursor', async ({ page }) => {
  await openEditor(page)
  // Two notes on the E string; the cursor is now past them, at slot 3.
  for (const slot of [1, 2]) {
    await page.getByRole('button', { name: `1 小節目 ${slot} 番目 E 弦` }).click()
  }
  await expect(page.locator('.tab-cell--note')).toHaveCount(2)

  await page.getByRole('button', { name: '1 小節目 1 番目 A 弦' }).click()

  // The first note moved to the A string. No third note appeared. Read the
  // lanes off the grid rather than out of storage: which string a note sits on
  // is what the person sees, and the stored shape is free to change.
  await expect(page.locator('.tab-cell--note')).toHaveCount(2)
  const lanes = await page
    .locator('.tab-cell--note')
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getAttribute('aria-label')?.match(/([GDAE]) 弦$/)?.[1]),
    )
  expect(lanes).toEqual(['A', 'E'])
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
 * A bar that is full has to hand the keystroke on rather than swallow it:
 * playing a phrase in is one run of keys, and stopping dead at a bar line --
 * with no message and nothing written -- reads as the editor being broken.
 */
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
 * The saved score is the one input nothing type-checks: it was written by
 * whatever version of the code ran last. Because it is persisted, a shape the
 * app cannot read does not fail once -- it fails on every reload, and the 新規
 * button that would clear it never renders. Every one of these used to leave a
 * blank page.
 */
test.describe('restoring a saved score', () => {
  const VERSION = 2
  const seed = (page: Page, entries: Record<string, unknown>) =>
    page.addInitScript((values) => {
      for (const [key, value] of Object.entries(values)) {
        localStorage.setItem(key, JSON.stringify(value))
      }
    }, entries)

  const scoreOf = (title: string, fret: number) => ({
    version: VERSION,
    score: {
      title,
      keyFifths: 0,
      time: { beats: 4, beatType: 4 },
      measures: [[{ kind: 'note', string: 4, fret, value: 4, dotted: false }], [], [], []],
    },
  })

  test('保存した譜面が一覧ごと戻る', async ({ page }) => {
    await seed(page, {
      'bass-tabs:index': { version: VERSION, ids: ['a', 'b'], currentId: 'b' },
      'bass-tabs:score:a': scoreOf('one', 3),
      'bass-tabs:score:b': scoreOf('two', 7),
    })

    await openEditor(page)

    await expect(page.locator('.score-row')).toHaveCount(2)
    // The score that was open is the one that opens again.
    await expect(page.locator('.tab-cell--note')).toHaveText(['7'])
    await expect(page.getByRole('status')).toContainText('two')
  })

  test('中身が壊れた譜面は落として、残りは開ける', async ({ page }) => {
    await seed(page, {
      'bass-tabs:index': { version: VERSION, ids: ['a', 'broken'], currentId: 'broken' },
      'bass-tabs:score:a': scoreOf('one', 3),
      'bass-tabs:score:broken': { version: VERSION, score: { title: 'x', measures: [[]] } },
    })

    await openEditor(page)

    await expect(page.locator('.score-row')).toHaveCount(1)
    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])
  })

  const BROKEN: { label: string; index: unknown }[] = [
    { label: '目次が JSON ですらない', index: 'not json at all' },
    { label: '目次が知らない版', index: { version: 999, ids: ['a'], currentId: 'a' } },
    { label: '目次の中身が壊れている', index: { version: VERSION, ids: 'nope' } },
  ]

  for (const { label, index } of BROKEN) {
    test(`${label}場合でも起動して空の譜面から始まる`, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('bass-tabs:index', typeof value === 'string' ? value : JSON.stringify(value))
      }, index)

      await openEditor(page)

      await expect(page.locator('.editor-panel')).toBeVisible()
      await expect(page.locator('.tab-cell--note')).toHaveCount(0)
      // Still a working editor, not just a page that rendered.
      await fillFirstMeasure(page, 'E')
      await expect(page.locator('svg.score-page')).toHaveCount(1)
    })
  }
})

/**
 * The library around the scores, as opposed to the notes inside one. Undo does
 * not reach these: its history describes edits within a score.
 */
test.describe('譜面の一覧', () => {
  test('譜面を足しても既にあるものは残る', async ({ page }) => {
    await openEditor(page)
    await fillFirstMeasure(page, 'E')
    await expect(page.locator('.score-row')).toHaveCount(1)

    await page.getByRole('button', { name: '＋ 追加' }).click()

    await expect(page.locator('.score-row')).toHaveCount(2)
    // The new one opens empty; the first is untouched behind it.
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)
    await page.locator('.score-row__open').first().click()
    await expect(page.locator('.tab-cell--note')).toHaveCount(4)
  })

  test('切り替えて戻しても内容が保たれる', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('7')

    await page.getByRole('button', { name: '＋ 追加' }).click()
    // Wait for the new score to actually be the open one: typing before the
    // switch has landed would write into the score being left.
    await expect(page.locator('.score-row').last()).toHaveClass(/score-row--current/)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('3')
    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])

    await page.locator('.score-row__open').first().click()
    await expect(page.locator('.tab-cell--note')).toHaveText(['7'])
    await page.locator('.score-row__open').last().click()
    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])
  })

  test('リロードしても一覧と開いていた譜面が残る', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '＋ 追加' }).click()
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('9')
    await expect(page.locator('.tab-cell--note')).toHaveText(['9'])

    await page.reload()
    await page.getByRole('button', { name: '譜面を作る' }).click()

    await expect(page.locator('.score-row')).toHaveCount(2)
    await expect(page.locator('.tab-cell--note')).toHaveText(['9'])
  })

  test('削除は確認を挟み、断れば消えない', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '＋ 追加' }).click()
    await expect(page.locator('.score-row')).toHaveCount(2)

    page.once('dialog', (dialog) => void dialog.dismiss())
    await page.locator('.score-row__delete').first().click()
    await expect(page.locator('.score-row')).toHaveCount(2)

    page.once('dialog', (dialog) => void dialog.accept())
    await page.locator('.score-row__delete').first().click()
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('最後の 1 つを消しても空の譜面が残る', async ({ page }) => {
    await openEditor(page)
    await fillFirstMeasure(page, 'E')

    page.once('dialog', (dialog) => void dialog.accept())
    await page.locator('.score-row__delete').first().click()

    // Always something open, so the editor never has nothing to edit.
    await expect(page.locator('.score-row')).toHaveCount(1)
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)
    await expect(page.locator('svg.score-page')).toHaveCount(1)
  })
})

/**
 * Lowering the measure count throws away those measures and everything in
 * them, with no undo, so a keystroke on the way to another number must not
 * reach the score. "12" typed over "4" used to truncate at the "1".
 */
test.describe('小節数の入力', () => {
  async function fillBars(page: Page, bars: number) {
    for (let bar = 1; bar <= bars; bar++) {
      await page.getByRole('button', { name: `${bar} 小節目 1 番目 E 弦` }).click()
    }
  }

  const notesPerBar = (page: Page) =>
    page
      .locator('.tab-measure')
      .evaluateAll((bars) => bars.map((bar) => bar.querySelectorAll('.tab-cell--note').length))

  test('2 桁に打ち替えても入力済みの音が消えない', async ({ page }) => {
    await openEditor(page)
    await fillBars(page, 4)
    expect(await notesPerBar(page)).toEqual([1, 1, 1, 1])

    const field = page.getByLabel('小節数')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.pressSequentially('12', { delay: 120 })
    await field.blur()

    expect(await notesPerBar(page)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  test('欄を空にしただけでは小節が削られない', async ({ page }) => {
    await openEditor(page)
    await fillBars(page, 4)

    const field = page.getByLabel('小節数')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.press('Backspace')
    await field.blur()

    // The field goes back to what the score holds; nothing was thrown away.
    await expect(field).toHaveValue('4')
    expect(await notesPerBar(page)).toEqual([1, 1, 1, 1])
  })

  test('確定した減少は今までどおり反映される', async ({ page }) => {
    await openEditor(page)
    await fillBars(page, 4)

    const field = page.getByLabel('小節数')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.pressSequentially('2')
    await field.press('Enter')

    expect(await notesPerBar(page)).toEqual([1, 1])
  })
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
 * OSMD rebuilds the whole score DOM on every edit, and while the container is
 * empty the browser drops the scroll offset -- so the page used to jump to the
 * top on every single note.
 *
 * Two things about writing this check. It measures where the score sits on
 * screen rather than `window.scrollY`, because an edit can legitimately change
 * the height of the grid above it (a rest label makes a column taller) and the
 * browser then shifts scrollY to keep the score still -- which is the outcome
 * we actually want. And it drives the editor by keyboard only: Playwright's
 * click() and focus() scroll the target into view themselves, which would mix
 * their scrolling in with the app's.
 */
test.describe('編集中のスクロール位置', () => {
  const scoreTop = (page: Page) =>
    page
      .locator('svg.score-page')
      .first()
      .evaluate((svg) => Math.round(svg.getBoundingClientRect().top))

  async function scrolledEditor(page: Page) {
    await openEditor(page)
    // Enough measures that the page is taller than the viewport.
    const field = page.getByLabel('小節数')
    await field.click()
    await field.press('ControlOrMeta+a')
    await field.pressSequentially('8')
    await field.press('Enter')
    await expect(page.locator('.tab-measure')).toHaveCount(8)

    await page.locator('.tab-editor').focus()
    await page.evaluate(() => window.scrollTo(0, 600))
    // Guards the check itself: if the page could not scroll, everything below
    // would pass without proving anything.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  }

  for (const [label, key] of [
    ['音を追加しても', '5'],
    ['休符を追加しても', 'r'],
  ] as const) {
    test(`${label}譜面の表示位置が動かない`, async ({ page }) => {
      await scrolledEditor(page)
      const before = await scoreTop(page)

      await page.keyboard.press(key)
      await expect(page.getByRole('status')).toContainText('ページ (A4 縦)')

      expect(await scoreTop(page)).toBe(before)
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    })
  }

  test('取り消しても譜面の表示位置が動かない', async ({ page }) => {
    await scrolledEditor(page)
    await page.keyboard.press('5')
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)
    const before = await scoreTop(page)

    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)

    expect(await scoreTop(page)).toBe(before)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  })
})

/**
 * The arrows move the note the grid is highlighting: unmodified they change its
 * pitch, with Shift they change which string plays that same pitch.
 */
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
 * Bass is written an octave above where it sounds. Written at pitch the open E
 * string needs three ledger lines and the low end is unreadable, which is the
 * whole reason for the shift.
 */
test.describe('記譜のオクターブ', () => {
  test('E 弦の開放が加線だらけにならない', async ({ page }) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('0')
    await expect(page.locator('.tab-cell--note')).toHaveText(['0'])
    await expect(page.getByRole('status')).toContainText('ページ (A4 縦)')

    const drawn = await page.locator('svg.score-page').first().evaluate((svg) => ({
      ledgers: svg.querySelectorAll('g.vf-ledgers *').length,
      frets: [...svg.querySelectorAll('g.vf-tabnote text')].map((text) => text.textContent),
    }))

    // Three ledger lines at sounding pitch, one an octave up. Two leaves slack
    // for however VexFlow decides to draw a line.
    expect(drawn.ledgers).toBeLessThanOrEqual(2)
    // The tab is about where you put your fingers, so it must not move.
    expect(drawn.frets).toEqual(['0'])
  })

  test('書き出したファイルが実音を宣言している', async ({ page }, testInfo) => {
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('0')
    await expect(page.locator('.tab-cell--note')).toHaveText(['0'])

    const download = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'MusicXML を書き出す' }).click(),
    ]).then(([event]) => event)
    const saved = testInfo.outputPath('octave.musicxml')
    await download.saveAs(saved)
    const xml = readFileSync(saved, 'utf8')

    // Written up: the open E string is E2 on paper, E1 in the ear.
    expect(xml).toContain('<step>E</step>')
    expect(xml).toContain('<octave>2</octave>')
    expect(xml).not.toContain('<octave>1</octave>')
    // ...and the file says so, so other software still knows the real pitch.
    expect(xml.replace(/\s+/g, ' ')).toContain(
      '<transpose> <chromatic>0</chromatic> <octave-change>-1</octave-change> </transpose>',
    )
  })
})

/**
 * The scores live only in `localStorage`, so clearing site data or moving
 * machines loses everything. These checks are about the way back.
 */
test.describe('書き出しと取り込み', () => {
  /**
   * Files handed to `setInputFiles` must live under an ASCII path.
   * `testInfo.outputPath()` builds its directory from the test title, and with
   * a Japanese title that path is non-ASCII -- Playwright then attaches
   * nothing, raises nothing, and the change event never fires. That looks
   * exactly like a broken import handler, which cost an hour to tell apart.
   */
  const fixtures = mkdtempSync(join(tmpdir(), 'bass-tabs-'))
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
    await page.getByRole('button', { name: '譜面を作る' }).click()
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

  test('TAB の無い MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    await page.setInputFiles('.sidebar input[type="file"]', 'public/samples/bass-standard.musicxml')

    await expect(page.locator('.sidebar__notice')).toContainText('TAB 譜が入っていない')
    await expect(page.locator('.score-row')).toHaveCount(1)
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
  // renders only because the editor happened to hold it in memory.
  await page.getByRole('button', { name: '譜面を作る' }).click()
  await page.setInputFiles('input[type="file"]', saved)
  await expect(page.getByRole('status')).toContainText('ページ (A4 縦)')
  await expect(page.locator('svg.score-page')).toHaveCount(1)
})

/**
 * The panel first shipped with `background: #fff` and no `color` while the
 * document declared `color-scheme: light dark`. Under a dark scheme the UA
 * paints control text near-white, so every field was white on white -- the app
 * looked fine to a light-mode screenshot and was unusable in dark mode.
 *
 * Contrast is asserted rather than colour values so the check survives a
 * repalette but still fails if text and background ever converge again.
 */
test.describe('dark colour scheme', () => {
  test.use({ colorScheme: 'dark' })

  test('every editor control keeps its text readable', async ({ page }) => {
    await openEditor(page)
    await fillFirstMeasure(page, 'E')

    const contrasts = await page.evaluate(() => {
      const channel = (value: number) => {
        const v = value / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      const luminance = (color: string) => {
        const [r, g, b] = (color.match(/\d+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
      }
      // Walks up for the nearest painted background, since controls sitting on
      // a transparent parent still read against whatever is behind them.
      const backgroundOf = (element: Element): string => {
        for (let node: Element | null = element; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor
          if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
        }
        return 'rgb(255, 255, 255)'
      }
      const selectors = [
        '.editor-field select',
        ".editor-field input[type='number']",
        '.editor-field input:not([type])',
        '.chip',
        '.editor-field',
        '.editor-help',
        '.tab-cell--note',
      ]
      return selectors.map((selector) => {
        const element = document.querySelector(selector)
        if (!element) return { selector, ratio: 0 }
        const styles = getComputedStyle(element)
        const [a, b] = [luminance(styles.color), luminance(backgroundOf(element))].sort(
          (x, y) => y - x,
        )
        return { selector, ratio: (a + 0.05) / (b + 0.05) }
      })
    })

    for (const { selector, ratio } of contrasts) {
      // 4.5:1 is the WCAG AA threshold for body text.
      expect(ratio, `${selector} contrast`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
