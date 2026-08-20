import { test, expect, type Page } from '@playwright/test'

/**
 * Guards the print contract: open a MusicXML file, then assert that what comes
 * out of the printer is A4 and paginated by OSMD.
 *
 * Both bugs recorded in README (実装上つまずいた点) are print-only and invisible
 * on screen, which is what makes them worth a browser-driven check.
 */

const MM_PER_PT = 25.4 / 72
const PX_PER_MM = 96 / 25.4

/** Every sample renders to two A4 pages; see README for the measured values. */
const SAMPLES = [
  { file: 'bass-standard.musicxml', pages: 2 },
  { file: 'bass-standard.mxl', pages: 2 },
  { file: 'bass-tab.musicxml', pages: 2 },
]

/**
 * Chromium writes an uncompressed page tree, so the page objects can be counted
 * without a PDF library. `/Type /Page` must not match `/Type /Pages` (the tree
 * root), hence the lookahead.
 */
function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

/** First /MediaBox in the file, converted to millimetres. */
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

async function openSample(page: Page, file: string) {
  await page.goto('/')
  await page.setInputFiles('input[type="file"]', `public/samples/${file}`)
  await expect(page.getByRole('status')).toContainText('ページ (A4 縦)')
}

for (const sample of SAMPLES) {
  test(`${sample.file} prints as ${sample.pages} A4 pages`, async ({ page }) => {
    await openSample(page, sample.file)

    const pages = page.locator('svg.score-page')
    await expect(pages).toHaveCount(sample.pages)
    await expect(page.getByRole('status')).toContainText(`${sample.pages} ページ`)

    // The SVG backend is a print-quality requirement: Canvas is raster and
    // prints with soft note edges.
    await expect(page.locator('canvas')).toHaveCount(0)

    const pdf = await page.pdf({ preferCSSPageSize: true })
    expect(pdfPageCount(pdf)).toBe(sample.pages)

    const size = pdfPageSizeMm(pdf)
    expect(size.width).toBeCloseTo(210, 0)
    expect(size.height).toBeCloseTo(297, 0)
  })
}

test('page breaks are assigned by index, not by :last-of-type', async ({ page }) => {
  await openSample(page, 'bass-standard.musicxml')

  // OSMD puts every page <svg> in its own wrapper <div>, so each page is both
  // the first and the last svg inside its parent and a CSS :last-of-type rule
  // matches all of them. The class therefore has to be assigned in JS, and this
  // is the assertion that notices if that regresses -- a wrong break-after on a
  // score whose pages exactly fill the sheet does not change the PDF page
  // count, so the PDF-level checks above cannot see it.
  const breaks = await page.locator('svg.score-page').evaluateAll((nodes) =>
    nodes.map((node) => node.classList.contains('score-page--break-after')),
  )
  expect(breaks.length).toBeGreaterThan(1)
  expect(breaks.slice(0, -1)).toEqual(breaks.slice(0, -1).map(() => true))
  expect(breaks.at(-1)).toBe(false)
})

test('a page fills its wrapper on screen and A4 on paper', async ({ page }) => {
  await openSample(page, 'bass-standard.musicxml')

  // makePagesScalable() strips width/height in favour of a viewBox, which
  // leaves the <svg> with no intrinsic size. On screen its width is
  // min(100%, 210mm), so if OSMD's per-page wrapper ever shrinks to fit, that
  // 100% resolves against a wrapper collapsed to the 300px replaced-element
  // default and the page renders as a thumbnail.
  const onScreen = await page.locator('svg.score-page').first().evaluate((svg) => ({
    page: svg.getBoundingClientRect().width,
    wrapper: svg.parentElement!.getBoundingClientRect().width,
  }))
  expect(onScreen.wrapper).toBeGreaterThan(300)
  expect(onScreen.page).toBeCloseTo(Math.min(onScreen.wrapper, 210 * PX_PER_MM), 0)

  await page.emulateMedia({ media: 'print' })
  const box = await page.locator('svg.score-page').first().boundingBox()
  // emulateMedia outlives navigation, so reset it before anything else runs.
  await page.emulateMedia({ media: null })

  expect(box?.width).toBeCloseTo(210 * PX_PER_MM, 0)
  expect(box?.height).toBeCloseTo(297 * PX_PER_MM, 0)
})
