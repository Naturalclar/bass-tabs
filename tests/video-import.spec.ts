import { test, expect, type Page } from '@playwright/test'
import { BASE_PATH } from '../base-path.ts'

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
