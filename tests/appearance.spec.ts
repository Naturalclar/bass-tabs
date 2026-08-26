import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fillFirstMeasure, openEditor } from './helpers.ts'

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
