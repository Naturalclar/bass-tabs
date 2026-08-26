import { test, expect, type Page } from '@playwright/test'
import { openEditor, screenshotTab, tabHtml } from './helpers.ts'

/**
 * Screenshot import: the pixel-analysis half is deterministic, and the OCR
 * half is pinned by synthetic screenshots rendered right here -- real images
 * would rot in the repo and hide *why* they look the way they do. Both ink
 * polarities are covered because a YouTube overlay is usually light-on-dark
 * while a scanned page is dark-on-light, and the analyser must not care.
 */
test.describe('画像からの取り込み', () => {
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

  test('符幹や浮いた数字が並ぶ実物風のオーバーレイでも和音扱いされない', async ({ page }) => {
    test.setTimeout(120_000)
    // Modelled on the reported frame: a play-through overlay hangs rhythm
    // stems and beams under the staff, extra numbers above it, X ghost
    // notes on the lines, a stem running through the bottom line, and a
    // playhead bar across all four. None of that is a note on another
    // string, but each lined up with a real digit and the capture was
    // refused as a chord.
    const lanes = [60, 95, 130, 165]
    const digits = [
      { lane: 3, x: 80, text: '4' },
      { lane: 2, x: 180, text: '6' },
      { lane: 2, x: 280, text: '5' },
      { lane: 1, x: 380, text: '0' },
    ]
    const overlay = `
      <div id="tab" style="position:relative;width:760px;height:260px;background:#f0b429;color:#221">
        ${lanes
          .map(
            (y) =>
              `<div style="position:absolute;left:16px;right:16px;top:${y}px;height:3px;background:#221"></div>`,
          )
          .join('')}
        ${digits
          .map(
            (note) =>
              `<span style="position:absolute;left:${note.x}px;top:${lanes[note.lane] + 2}px;transform:translateY(-50%);background:#f0b429;padding:0 2px;font:700 22px monospace">${note.text}</span>`,
          )
          .join('')}
        <span style="position:absolute;left:180px;top:${lanes[0] - 32}px;font:700 20px monospace">5</span>
        <span style="position:absolute;left:480px;top:${lanes[1] + 2}px;transform:translateY(-50%);background:#f0b429;padding:0 2px;font:700 22px monospace">X</span>
        ${digits
          .map(
            (note) =>
              `<div style="position:absolute;left:${note.x + 4}px;top:${lanes[3] + 16}px;width:3px;height:16px;background:#221"></div>`,
          )
          .join('')}
        <div style="position:absolute;left:84px;top:${lanes[3] + 32}px;width:200px;height:4px;background:#221"></div>
        <div style="position:absolute;left:560px;top:${lanes[3] - 13}px;width:3px;height:29px;background:#221"></div>
        <div style="position:absolute;left:320px;top:${lanes[0] - 14}px;width:8px;height:${lanes[3] - lanes[0] + 28}px;background:#3a3;border-radius:4px"></div>
      </div>`
    const image = await screenshotTab(page, 'overlay.png', overlay)
    await openEditor(page)
    await importImage(page, image)

    // The X is a ghost note the model cannot spell: it lands as a rest, and
    // the notice says one thing went unread instead of refusing everything.
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    expect(await notes(page)).toEqual(['E4', 'A6', 'A5', 'D0'])
    await expect(page.locator('.tab-column__rest')).toHaveCount(1)
  })

  test('同じ位置に 2 本の弦の数字がある画像は和音として取り込める', async ({ page }) => {
    test.setTimeout(120_000)
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

    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    // One beat, two strings: the same column holds both.
    const cells = await page
      .locator('.tab-cell--note')
      .evaluateAll((all) =>
        all.map(
          (cell) =>
            (cell.getAttribute('aria-label') ?? '').match(/(\d+) 番目 ([GDAE]) 弦$/)?.slice(1, 3).join('') +
            cell.textContent,
        ),
      )
    expect(cells).toEqual(['1G3', '1A5'])
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
