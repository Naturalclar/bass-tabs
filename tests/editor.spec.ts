import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_PATH } from '../base-path.ts'
import { pdfPageCount, pdfPageSizeMm } from './pdf.ts'
import { schedule, secondsPerTick } from '../src/editor/playback.ts'
import {
  DIVISIONS,
  type Entry,
  type NoteValue,
  type Score,
  type TimeSignature,
} from '../src/editor/model.ts'

/**
 * The editor's whole point is that its output goes through the same path as an
 * imported file, so these checks end where the import checks end: at the PDF.
 * Rendering in the browser is not enough -- MusicXML that OSMD draws on screen
 * can still paginate wrongly, and printing is what this app is for.
 */




async function openEditor(page: Page) {
  // The editor is the first view -- opening the site is opening the editor.
  await page.goto(BASE_PATH)
  await page.locator('.tab-editor').waitFor()
}

/** Fills measure 1 with four quarter notes on the given string. */
async function fillFirstMeasure(page: Page, stringLabel: string) {
  for (let i = 1; i <= 4; i++) {
    await page.getByRole('button', { name: `1 小節目 ${i} 番目 ${stringLabel} 弦` }).click()
  }
}

/**
 * The first thing on screen is a score, not an empty page waiting for a file.
 * There is always one to show -- the storage layer restores whatever was open
 * last, or an empty score -- and a returning user came back for theirs.
 */
test('the first view is the score, not the file picker', async ({ page }) => {
  await page.goto(BASE_PATH)

  await expect(page.locator('svg.score-page')).toHaveCount(1)
  await expect(page.locator('.tab-editor')).toBeVisible()
})

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

  test('和音入りの MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    const chord = quarterOn(4, 0) + quarterOn(3, 2, '<chord/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('chord.musicxml', tabXml(1, chord)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('和音・タイ・装飾音')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('タイ入りの MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    const tied = quarterOn(4, 0, '<tie type="start"/>') + quarterOn(4, 0, '<tie type="stop"/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('tie.musicxml', tabXml(1, tied)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('和音・タイ・装飾音')
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
 * Screenshot import: the pixel-analysis half is deterministic, and the OCR
 * half is pinned by synthetic screenshots rendered right here -- real images
 * would rot in the repo and hide *why* they look the way they do. Both ink
 * polarities are covered because a YouTube overlay is usually light-on-dark
 * while a scanned page is dark-on-light, and the analyser must not care.
 */
test.describe('画像からの取り込み', () => {
  const fixtures = mkdtempSync(join(tmpdir(), 'bass-tabs-'))

  function tabHtml(opts: {
    dark?: boolean
    /** Draw digits straight over the lines, no backing patch -- the hard case. */
    plain?: boolean
    notes: { lane: number; x: number; text: string }[]
  }) {
    const ink = opts.dark ? '#eee' : '#111'
    const paper = opts.dark ? '#181818' : '#fff'
    const lanes = [30, 60, 90, 120]
    return `
      <div id="tab" style="position:relative;width:640px;height:150px;background:${paper};font:700 20px monospace;color:${ink}">
        ${lanes
          .map(
            (y) =>
              `<div style="position:absolute;left:16px;right:16px;top:${y}px;height:2px;background:${ink}"></div>`,
          )
          .join('')}
        ${opts.notes
          .map(
            (note) =>
              `<span style="position:absolute;left:${note.x}px;top:${lanes[note.lane] + 1}px;transform:translateY(-50%);${opts.plain ? '' : `background:${paper};padding:0 2px`}">${note.text}</span>`,
          )
          .join('')}
      </div>`
  }

  /** Renders the mock tab and screenshots it -- the "image from a video". */
  async function screenshotTab(page: Page, name: string, html: string) {
    const path = join(fixtures, name)
    await page.setContent(`<body style="margin:0">${html}</body>`)
    writeFileSync(path, await page.locator('#tab').screenshot())
    return path
  }

  async function importImage(page: Page, path: string) {
    await page.setInputFiles('.sidebar input[type="file"]', path)
    // OCR takes a moment; the settled notice is the completion signal.
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.sidebar__notice')
          ?.textContent?.includes('読み取っています'),
      undefined,
      { timeout: 90_000 },
    )
  }

  const notes = (page: Page) =>
    page
      .locator('.tab-cell--note')
      .evaluateAll((cells) =>
        cells.map(
          (cell) =>
            (cell.getAttribute('aria-label') ?? '').match(/([GDAE]) 弦/)?.[1] + cell.textContent,
        ),
      )

  test('黒地に白のタブ譜が弦とフレットごと読める', async ({ page }) => {
    test.setTimeout(120_000)
    const image = await screenshotTab(
      page,
      'dark.png',
      tabHtml({
        dark: true,
        notes: [
          { lane: 3, x: 60, text: '3' },
          { lane: 2, x: 140, text: '10' },
          { lane: 1, x: 220, text: '0' },
          { lane: 0, x: 300, text: '24' },
        ],
      }),
    )
    await openEditor(page)
    await importImage(page, image)

    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    expect(await notes(page)).toEqual(['E3', 'A10', 'D0', 'G24'])
    // Everything lands as an eighth note: rhythm is not guessed from pixels,
    // the editor is where it gets fixed.
    await expect(page.locator('.tab-column__value').first()).toHaveText('♪')
    // The score is named after the file and survives a reload -- what came
    // through OCR passes the same storage validation as everything else.
    await page.reload()
    await expect(page.locator('.score-row--current')).toContainText('dark')
    expect(await notes(page)).toEqual(['E3', 'A10', 'D0', 'G24'])
  })

  test('白地に黒でも同じに読める', async ({ page }) => {
    test.setTimeout(120_000)
    const image = await screenshotTab(
      page,
      'light.png',
      tabHtml({
        notes: [
          { lane: 3, x: 60, text: '5' },
          { lane: 1, x: 140, text: '12' },
        ],
      }),
    )
    await openEditor(page)
    await importImage(page, image)
    expect(await notes(page)).toEqual(['E5', 'D12'])
  })

  test('数字が弦の線をまたいでいても読める', async ({ page }) => {
    test.setTimeout(120_000)
    // No backing patch: the line runs straight through every digit, the way
    // overlays often draw them. Erasing the line must spare the strokes that
    // cross it, or the digits fall apart before OCR ever sees them.
    const image = await screenshotTab(
      page,
      'crossed.png',
      tabHtml({
        plain: true,
        notes: [
          { lane: 3, x: 60, text: '3' },
          { lane: 2, x: 140, text: '8' },
          { lane: 0, x: 220, text: '12' },
        ],
      }),
    )
    await openEditor(page)
    await importImage(page, image)
    expect(await notes(page)).toEqual(['E3', 'A8', 'G12'])
  })

  test('小節に収まらない分は次の小節へ流れる', async ({ page }) => {
    test.setTimeout(120_000)
    const image = await screenshotTab(
      page,
      'nine.png',
      tabHtml({
        notes: Array.from({ length: 9 }, (_, i) => ({ lane: 3, x: 40 + i * 60, text: '3' })),
      }),
    )
    await openEditor(page)
    await importImage(page, image)

    // Nine eighth notes: eight fill the first 4/4 bar, the ninth starts the next.
    const perBar = await page
      .locator('.tab-measure')
      .evaluateAll((bars) => bars.map((bar) => bar.querySelectorAll('.tab-cell--note').length))
    expect(perBar).toEqual([8, 1])
  })

  test('タブ譜以外が写り込んだスクリーンショットでも読める', async ({ page }) => {
    test.setTimeout(120_000)
    // The reported real-world failure: a capture of the whole tab -- dark
    // browser UI around a bright video -- inverted the global ink guess and
    // the four lines drowned. The staff has to be found by its geometry
    // (four long, thin, evenly spaced lines), not by whole-image statistics.
    const lanes = [60, 100, 140, 180]
    const overlay = `
      <div id="tab" style="position:relative;width:900px;height:640px;background:#1f2124;color:#ddd;font:14px sans-serif">
        <div style="position:absolute;left:0;top:0;width:170px;height:640px;background:#26282c;padding:8px">サイドバー<br>無題 4 小節<br>無題 4 小節</div>
        <div style="position:absolute;left:200px;top:40px;width:660px;height:300px;background:#f0b429">
          ${lanes
            .map(
              (y) =>
                `<div style="position:absolute;left:20px;right:20px;top:${y}px;height:3px;background:#221"></div>`,
            )
            .join('')}
          <span style="position:absolute;left:120px;top:${lanes[3] + 2}px;transform:translateY(-50%);color:#221;font:700 22px monospace">5</span>
          <span style="position:absolute;left:260px;top:${lanes[2] + 2}px;transform:translateY(-50%);color:#221;font:700 22px monospace">7</span>
          <span style="position:absolute;left:400px;top:${lanes[0] + 2}px;transform:translateY(-50%);color:#221;font:700 22px monospace">12</span>
        </div>
      </div>`
    const image = await screenshotTab(page, 'busy.png', overlay)
    await openEditor(page)
    await importImage(page, image)

    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    expect(await notes(page)).toEqual(['E5', 'A7', 'G12'])
  })

  test('五線譜が並んでいても 4 本線のタブ譜の方を読む', async ({ page }) => {
    test.setTimeout(120_000)
    // A five-line notation staff above the tab, the way play-through videos
    // draw both. Four of its five lines are also evenly spaced, so reading
    // them would import plausible-looking wrong notes.
    const staff = [24, 40, 56, 72, 88]
    const lanes = [150, 185, 220, 255]
    const overlay = `
      <div id="tab" style="position:relative;width:700px;height:320px;background:#fff;color:#111">
        ${staff
          .map(
            (y) =>
              `<div style="position:absolute;left:30px;right:30px;top:${y}px;height:2px;background:#111"></div>`,
          )
          .join('')}
        ${lanes
          .map(
            (y) =>
              `<div style="position:absolute;left:30px;right:30px;top:${y}px;height:2px;background:#111"></div>`,
          )
          .join('')}
        <span style="position:absolute;left:120px;top:${lanes[3] + 1}px;transform:translateY(-50%);background:#fff;padding:0 2px;font:700 20px monospace">3</span>
        <span style="position:absolute;left:260px;top:${lanes[1] + 1}px;transform:translateY(-50%);background:#fff;padding:0 2px;font:700 20px monospace">9</span>
      </div>`
    const image = await screenshotTab(page, 'two-staffs.png', overlay)
    await openEditor(page)
    await importImage(page, image)

    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    expect(await notes(page)).toEqual(['E3', 'D9'])
  })

  test('同じ位置に 2 本の弦の数字がある画像は取り込まず、理由を出す', async ({ page }) => {
    const image = await screenshotTab(
      page,
      'chord.png',
      tabHtml({
        notes: [
          { lane: 0, x: 60, text: '3' },
          { lane: 2, x: 60, text: '5' },
        ],
      }),
    )
    await openEditor(page)
    await importImage(page, image)

    await expect(page.locator('.sidebar__notice')).toContainText('和音は持てない')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('弦の線が無い画像は取り込まず、理由を出す', async ({ page }) => {
    const image = await screenshotTab(
      page,
      'no-lanes.png',
      `<div id="tab" style="width:400px;height:120px;background:#fff;color:#111;font:20px monospace">ただの文字</div>`,
    )
    await openEditor(page)
    await importImage(page, image)

    await expect(page.locator('.sidebar__notice')).toContainText('弦の線が見つかりませんでした')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })
})

/**
 * Video mode. getDisplayMedia never works headless (measured back in #11), so
 * the fake share draws a synthetic tab on a canvas and hands back its
 * captureStream() -- everything after the permission grant (decode, capture,
 * pixel analysis, OCR, append) is the real path. The permission dialog itself
 * is the one thing these tests cannot touch.
 */
test.describe('動画からの取り込み', () => {
  async function stubShare(page: Page) {
    await page.addInitScript(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 220
      const draw = () => {
        const g = canvas.getContext('2d') as CanvasRenderingContext2D
        g.fillStyle = '#181818'
        g.fillRect(0, 0, 800, 220)
        g.fillStyle = '#eee'
        const lanes = [60, 95, 130, 165]
        for (const y of lanes) g.fillRect(20, y, 760, 2)
        g.font = '700 24px monospace'
        g.textBaseline = 'middle'
        const paint = (lane: number, x: number, text: string) => {
          g.fillStyle = '#181818'
          g.fillRect(x - 2, lanes[lane] - 12, g.measureText(text).width + 4, 26)
          g.fillStyle = '#eee'
          g.fillText(text, x, lanes[lane] + 1)
        }
        paint(3, 80, '3')
        paint(2, 200, '10')
        paint(0, 320, '5')
      }
      draw()
      // A still canvas emits no frames; redrawing keeps the stream alive.
      setInterval(draw, 200)
      navigator.mediaDevices.getDisplayMedia = () => Promise.resolve(canvas.captureStream(5))
    })
  }

  async function openVideoMode(page: Page) {
    await page.goto(BASE_PATH)
    await page.locator('.tab-editor').waitFor()
    await page.getByRole('button', { name: '動画から取り込む' }).click()
  }

  async function capture(page: Page) {
    await page.getByRole('button', { name: '今の画面を読み取る' }).click()
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.video-import__notice')
          ?.textContent?.includes('読み取っています'),
      undefined,
      { timeout: 90_000 },
    )
  }

  const notes = (page: Page) =>
    page
      .locator('.tab-cell--note')
      .evaluateAll((cells) =>
        cells.map(
          (cell) =>
            (cell.getAttribute('aria-label') ?? '').match(/([GDAE]) 弦/)?.[1] + cell.textContent,
        ),
      )

  test('共有した画面のタブ譜が譜面の末尾に足されていく', async ({ page }) => {
    test.setTimeout(120_000)
    await stubShare(page)
    await openVideoMode(page)
    await page.getByRole('button', { name: '画面共有を開始' }).click()

    await capture(page)
    await expect(page.locator('.video-import__notice')).toContainText('3 音を譜面の末尾に足しました')

    // Two more screenfuls: nine eighth notes cross into a second 4/4 bar.
    await capture(page)
    await capture(page)

    // One Ctrl+Z takes back exactly one capture, right here in video mode.
    await page.keyboard.press('ControlOrMeta+z')

    await page.getByRole('button', { name: '譜面を作る' }).click()
    expect(await notes(page)).toEqual(['E3', 'A10', 'G5', 'E3', 'A10', 'G5'])
    // Six eighth notes pack into one 4/4 bar: captures continue the bar they
    // land in rather than each opening a fresh one.
    const perBar = await page
      .locator('.tab-measure')
      .evaluateAll((bars) => bars.map((bar) => bar.querySelectorAll('.tab-cell--note').length))
    expect(perBar).toEqual([6])
  })

  test('動画モードでは譜面の表示が隠れる', async ({ page }) => {
    // The capture films this same tab; staff lines on screen would read as
    // false string lines, so the rendered score must not be visible here.
    await openVideoMode(page)
    await expect(page.locator('.sheet')).toBeHidden()
    await page.getByRole('button', { name: '譜面を作る' }).click()
    await expect(page.locator('.sheet')).toBeVisible()
  })

  test('リンクの形を見て埋め込みを出し、読めないリンクは断る', async ({ page }) => {
    await openVideoMode(page)
    const field = page.getByLabel('YouTube のリンク')

    await field.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')
    await expect(page.locator('.video-import__player')).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    )

    await field.fill('https://youtu.be/dQw4w9WgXcQ')
    await expect(page.locator('.video-import__player')).toHaveAttribute('src', /dQw4w9WgXcQ/)

    await field.fill('https://example.com/watch?v=dQw4w9WgXcQ')
    await expect(page.locator('.video-import__notice')).toContainText('YouTube のリンクとして読めません')
    await expect(page.locator('.video-import__player')).toHaveCount(0)
  })

  test('画面共有が使えないときは理由を出す', async ({ page }) => {
    // Headless Chromium rejects getDisplayMedia -- which is exactly the
    // environment of a browser with capture unavailable or denied.
    await openVideoMode(page)
    await page.getByRole('button', { name: '画面共有を開始' }).click()
    await expect(page.locator('.video-import__notice')).toContainText(
      '画面共有を開始できませんでした',
    )
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

/**
 * 再生のスケジュールは純関数なので、ブラウザ抜きでここで検査する。ヘッドレスでは
 * 音そのものは聞けないため、時刻と長さの計算がこの機能の検査可能なすべてになる。
 */
test.describe('再生のスケジュール', () => {
  const quarter = DIVISIONS

  const note = (fret: number, value: NoteValue = 4, dotted = false): Entry => ({
    kind: 'note',
    string: 4,
    fret,
    value,
    dotted,
  })
  const rest = (value: NoteValue = 4): Entry => ({ kind: 'rest', value, dotted: false })
  const scoreOf = (
    measures: Entry[][],
    time: TimeSignature = { beats: 4, beatType: 4 },
  ): Score => ({ title: '', keyFifths: 0, time, measures })

  test('音は実音で鳴り、休符は時間だけ進める', () => {
    const notes = schedule(scoreOf([[note(0), rest(), note(2)]]))
    // 開放 E は E1 (MIDI 28)。記譜は 1 オクターブ上だが、それは musicxml.ts の
    // 中だけの話で、鳴らす高さは弾く高さのまま。
    expect(notes).toEqual([
      { midi: 28, startTicks: 0, durationTicks: quarter },
      { midi: 30, startTicks: quarter * 2, durationTicks: quarter },
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
test.describe('再生', () => {
  test('空の譜面は再生できず、音を置くと再生 → 停止で戻る', async ({ page }) => {
    await openEditor(page)
    const play = page.getByRole('button', { name: '再生' })
    await expect(play).toBeDisabled()

    await fillFirstMeasure(page, 'E')
    await expect(play).toBeEnabled()

    // 遅くして、検査が押すより先に再生が終わってしまわないようにする
    await page.getByLabel('BPM').fill('30')
    await play.click()
    const stop = page.getByRole('button', { name: '停止' })
    await expect(stop).toBeVisible()

    await stop.click()
    await expect(page.getByRole('button', { name: '再生' })).toBeEnabled()
  })

  test('譜面を切り替えると再生は止まる', async ({ page }) => {
    await openEditor(page)
    await fillFirstMeasure(page, 'E')
    await page.getByLabel('BPM').fill('30')
    await page.getByRole('button', { name: '再生' }).click()
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible()

    await page.getByRole('button', { name: '＋ 追加' }).click()

    // 新しい譜面は空なので、再生は止まり、鳴らすものも無い
    const play = page.getByRole('button', { name: '再生' })
    await expect(play).toBeVisible()
    await expect(play).toBeDisabled()
  })
})
