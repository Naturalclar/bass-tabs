import { type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_PATH } from '../base-path.ts'

/**
 * Shared tools for the editor specs (everything but print.spec.ts).
 *
 * The editor's whole point is that its output goes through the same path as an
 * imported file, so these checks end where the import checks end: at the PDF.
 * Rendering in the browser is not enough -- MusicXML that OSMD draws on screen
 * can still paginate wrongly, and printing is what this app is for.
 */

export async function openEditor(page: Page) {
  // The editor is the first view -- opening the site is opening the editor.
  await page.goto(BASE_PATH)
  await page.locator('.tab-editor').waitFor()
}

/** Fills measure 1 with four quarter notes on the given string. */
export async function fillFirstMeasure(page: Page, stringLabel: string) {
  for (let i = 1; i <= 4; i++) {
    await page.getByRole('button', { name: `1 小節目 ${i} 番目 ${stringLabel} 弦` }).click()
  }
}

/**
 * Files handed to `setInputFiles` must live under an ASCII path.
 * `testInfo.outputPath()` builds its directory from the test title, and with
 * a Japanese title that path is non-ASCII -- Playwright then attaches
 * nothing, raises nothing, and the change event never fires. That looks
 * exactly like a broken import handler, which cost an hour to tell apart.
 * Every file a test feeds back into the app goes under a directory from
 * here instead.
 */
export function asciiFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'bass-tabs-'))
}

export function tabHtml(opts: {
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

let screenshotDir: string | undefined

/** Renders the mock tab and screenshots it -- the "image from a video". */
export async function screenshotTab(page: Page, name: string, html: string) {
  screenshotDir ??= asciiFixtureDir()
  const path = join(screenshotDir, name)
  await page.setContent(`<body style="margin:0">${html}</body>`)
  writeFileSync(path, await page.locator('#tab').screenshot())
  return path
}
