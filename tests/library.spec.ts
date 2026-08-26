import { test, expect, type Page } from '@playwright/test'
import { BASE_PATH } from '../base-path.ts'
import { fillFirstMeasure, openEditor } from './helpers.ts'

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

  test('初回訪問の編集もリロードで残る', async ({ page }) => {
    // No seeding: the very first visit invents its library in memory, and the
    // index used to be written only by sidebar actions -- so a first session
    // that never touched the sidebar saved its score under an id no index
    // named, and a reload silently started over.
    await openEditor(page)
    await page.locator('.tab-editor').focus()
    await page.keyboard.press('7')
    await expect(page.locator('.tab-cell--note')).toHaveText(['7'])

    await page.reload()
    await page.locator('.tab-editor').waitFor()
    await expect(page.locator('.tab-cell--note')).toHaveText(['7'])
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
