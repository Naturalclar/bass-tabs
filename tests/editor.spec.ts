import { test, expect, type Page } from '@playwright/test'
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

test('a measure cannot be overfilled past its time signature', async ({ page }) => {
  await openEditor(page)
  await fillFirstMeasure(page, 'E')
  await expect(page.getByText('この小節の残り: 0 拍')).toBeVisible()

  // 4/4 is full after four quarters, so a fifth click must not add anything.
  const before = await page.locator('.tab-cell--note').count()
  await page.getByRole('button', { name: '1 小節目 5 番目 E 弦' }).click()
  expect(await page.locator('.tab-cell--note').count()).toBe(before)
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
 * The saved score is the one input nothing type-checks: it was written by
 * whatever version of the code ran last. Because it is persisted, a shape the
 * app cannot read does not fail once -- it fails on every reload, and the 新規
 * button that would clear it never renders. Every one of these used to leave a
 * blank page.
 */
test.describe('restoring a saved score', () => {
  const BROKEN: { label: string; stored: string }[] = [
    { label: '拍子が欠けている', stored: '{"title":"x","keyFifths":0,"measures":[[]]}' },
    {
      label: '音の中身が壊れている',
      stored:
        '{"title":"x","keyFifths":0,"time":{"beats":4,"beatType":4},"measures":[[{"kind":"note"}]]}',
    },
    { label: 'JSON ですらない', stored: 'not json at all' },
    {
      label: '知らない版で書かれている',
      stored: '{"version":999,"score":{"title":"x","keyFifths":0,"time":{"beats":4,"beatType":4},"measures":[[]]}}',
    },
  ]

  for (const { label, stored } of BROKEN) {
    test(`${label}保存データでも起動して空の譜面から始まる`, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('bass-tabs:score', value)
      }, stored)

      await openEditor(page)

      await expect(page.locator('.editor-panel')).toBeVisible()
      await expect(page.locator('.tab-cell--note')).toHaveCount(0)
      // Still a working editor, not just a page that rendered.
      await fillFirstMeasure(page, 'E')
      await expect(page.locator('svg.score-page')).toHaveCount(1)
    })
  }

  test('版の無い古い保存データは読み直せる', async ({ page }) => {
    // What shipped before the envelope existed: a bare Score.
    await page.addInitScript(() => {
      localStorage.setItem(
        'bass-tabs:score',
        JSON.stringify({
          title: 'legacy',
          keyFifths: 0,
          time: { beats: 4, beatType: 4 },
          measures: [[{ kind: 'note', string: 4, fret: 3, value: 4, dotted: false }], [], [], []],
        }),
      )
    })

    await openEditor(page)

    await expect(page.locator('.tab-cell--note')).toHaveText(['3'])
    await expect(page.getByRole('status')).toContainText('legacy')
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

  test('新規も取り消せる', async ({ page }) => {
    await openEditor(page)
    await page.getByRole('button', { name: '1 小節目 1 番目 E 弦' }).click()
    await page.getByRole('button', { name: '新規' }).click()
    await expect(page.locator('.tab-cell--note')).toHaveCount(0)

    await page.locator('.tab-editor').focus()
    await undo(page)
    await expect(page.locator('.tab-cell--note')).toHaveCount(1)
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
