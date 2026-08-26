import { test, expect, type Page } from '@playwright/test'
import { BASE_PATH } from '../base-path.ts'

/**
 * The editor's whole point is that its output goes through the same path as an
 * imported file, so these checks end where the import checks end: at the PDF.
 * Rendering in the browser is not enough -- MusicXML that OSMD draws on screen
 * can still paginate wrongly, and printing is what this app is for.
 */

const MM_PER_PT = 25.4 / 72

function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

function pdfPageSizeMm(pdf: Buffer): { width: number; height: number } {
  const box = pdf
    .toString('latin1')
    .match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/)
  if (!box) throw new Error('no /MediaBox in the generated PDF')
  return {
    width: (Number(box[3]) - Number(box[1])) * MM_PER_PT,
    height: (Number(box[4]) - Number(box[2])) * MM_PER_PT,
  }
}

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

  // The first note moved to the A string. No third note appeared.
  await expect(page.locator('.tab-cell--note')).toHaveCount(2)
  const strings = await page.locator('svg.score-page').first().evaluate(() => {
    const stored = localStorage.getItem('bass-tabs:score')
    const score = JSON.parse(stored ?? '{}') as { measures: { string?: number }[][] }
    return score.measures[0].map((entry) => entry.string)
  })
  expect(strings).toEqual([3, 4])
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
