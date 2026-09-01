import { test, expect, type Page } from '@playwright/test'
import { BASE_PATH } from '../base-path.ts'
import { pdfPageCount, pdfPageSizeMm } from './pdf.ts'

/**
 * Guards the print contract: open a MusicXML file, then assert that what comes
 * out of the printer is A4 and paginated by OSMD.
 *
 * Both bugs recorded in README (実装上つまずいた点) come from OSMD's per-page
 * wrapper divs, and neither is visible to oxlint or tsc -- one only shows up in
 * the printed PDF, the other only in the on-screen layout. So the checks below
 * deliberately measure both media, not just print.
 */

const PX_PER_MM = 96 / 25.4

/** Every sample renders to two A4 pages; see README for the measured values. */
const SAMPLES = [
  { file: 'bass-standard.musicxml', pages: 2 },
  { file: 'bass-standard.mxl', pages: 2 },
  { file: 'bass-tab.musicxml', pages: 2 },
  // Same score with measure 2 rewritten as four eighth-note triplets: the
  // tuplet brackets must not repaginate the document (#77).
  { file: 'bass-tab-triplets.musicxml', pages: 2 },
  // Same score on a five-string bass. The tab staff is a line taller, which
  // is exactly the kind of change that moves page breaks (#74) -- measured,
  // it still lands on two.
  { file: 'bass-tab-5string.musicxml', pages: 2 },
]



async function openSample(page: Page, file: string) {
  // Navigate to the real path rather than '/'. `vite preview` happens to
  // redirect the origin root to the base path, but GitHub Pages serves the
  // site only from the base path and offers no such redirect, so going
  // through '/' would exercise a convenience of the test server instead.
  await page.goto(BASE_PATH)
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

test('三連符のブラケットと 3 が両方の譜表に出る', async ({ page }) => {
  await openSample(page, 'bass-tab-triplets.musicxml')

  // OSMD draws the tuplet number on the notation staff *and* the tab staff
  // (measured before building this: four groups, so eight marks). Reading the
  // rendered text rather than the file is the point -- the file always said 3.
  const threes = await page
    .locator('svg.score-page text')
    .evaluateAll((nodes) => nodes.filter((node) => node.textContent?.trim() === '3').length)
  expect(threes).toBeGreaterThanOrEqual(8)
})

/**
 * The lines of the first system's tab staff. OSMD draws staff lines as wide,
 * hair-thin `<path>`s; the notation staff is always the first five, and the
 * tab staff is the group under it (its lines sit further apart, so a gap
 * threshold separates the two staves cleanly).
 */
async function tabStaffLines(page: Page): Promise<number> {
  return page.locator('svg.score-page').first().evaluate((svg) => {
    const rows = [
      ...new Set(
        [...svg.querySelectorAll('path')]
          .map((node) => node.getBBox())
          .filter((box) => box.width > 150 && box.height <= 4)
          .map((box) => Math.round(box.y)),
      ),
    ].sort((a, b) => a - b)
    // Past the five notation lines, take the run that stays close together.
    const tab = rows.slice(5)
    let count = 0
    for (const [index, y] of tab.entries()) {
      if (index > 0 && y - tab[index - 1] > 20) break
      count++
    }
    return count
  })
}

test('TAB 譜の線の数は宣言した弦の数になる', async ({ page }) => {
  // Paired on purpose: the same score, four strings and five. Reading only
  // the five-string one could pass on a hard-coded 5, and reading only the
  // four-string one is what the suite already did.
  await openSample(page, 'bass-tab.musicxml')
  expect(await tabStaffLines(page)).toBe(4)

  await openSample(page, 'bass-tab-5string.musicxml')
  expect(await tabStaffLines(page)).toBe(5)
})

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
