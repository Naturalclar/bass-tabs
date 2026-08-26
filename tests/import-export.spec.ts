import { test, expect, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importFile, isTabImage } from '../src/editor/importFile.ts'
import { toBackup } from '../src/editor/backup.ts'
import { emptyScore } from '../src/editor/model.ts'
import { asciiFixtureDir, fillFirstMeasure, openEditor } from './helpers.ts'

/**
 * The scores live only in `localStorage`, so clearing site data or moving
 * machines loses everything. These checks are about the way back.
 */
test.describe('書き出しと取り込み', () => {
  // An ASCII directory, not testInfo.outputPath: see the setInputFiles trap
  // on asciiFixtureDir in helpers.ts.
  const fixtures = asciiFixtureDir()
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

  test('和音入りの MusicXML を和音のまま取り込める', async ({ page }) => {
    await openEditor(page)

    // A chord tone rides the previous note's beat: one column, two strings.
    const chord = quarterOn(4, 0) + quarterOn(3, 2, '<chord/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('chord.musicxml', tabXml(1, chord)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
    const cells = await page
      .locator('.tab-cell--note')
      .evaluateAll((all) =>
        all.map(
          (cell) =>
            (cell.getAttribute('aria-label') ?? '').match(/(\d+) 番目 ([GDAE]) 弦$/)?.slice(1, 3).join('') +
            cell.textContent,
        ),
      )
    expect(cells).toEqual(['1A2', '1E0'])
  })

  test('同じ弦が 2 回鳴る和音は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    // The one chord the model cannot spell: both tones on the same string.
    const doubled = quarterOn(4, 0) + quarterOn(4, 5, '<chord/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('doubled.musicxml', tabXml(1, doubled)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('タイ・装飾音')
    await expect(page.locator('.score-row')).toHaveCount(1)
  })

  test('タイ入りの MusicXML は取り込まず、理由を出す', async ({ page }) => {
    await openEditor(page)

    const tied = quarterOn(4, 0, '<tie type="start"/>') + quarterOn(4, 0, '<tie type="stop"/>')
    await page.setInputFiles(
      '.sidebar input[type="file"]',
      fixture('tie.musicxml', tabXml(1, tied)),
    )
    await expect(page.locator('.sidebar__notice')).toContainText('タイ・装飾音')
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
 * 取り込みファイルの振り分け (importFile.ts)。読み手の断り → 通知文の対応は
 * ここで直接検査する。MusicXML と画像の経路の中身はブラウザが要る (DOMParser /
 * OCR) ので、その通知は既存の e2e（書き出しと取り込み・画像からの取り込み）が
 * 実画面で踏んでいる。
 */
test.describe('取り込みファイルの振り分け', () => {
  const jsonFile = (text: string) => new File([text], 'library.json', { type: 'application/json' })

  test('書き出した JSON はそのまま戻り、曲数を告げる', async () => {
    const text = toBackup([
      { id: 'a', score: emptyScore() },
      { id: 'b', score: emptyScore() },
    ])
    const outcome = await importFile(jsonFile(text))
    expect(outcome.scores).toHaveLength(2)
    expect(outcome.notice).toBe('2 曲を取り込みました')
  })

  test('読めない JSON は理由を告げて、何も足さない', async () => {
    // bass-tabs の書き出しではない JSON
    const wrongFormat = await importFile(jsonFile(JSON.stringify({ hello: 1 })))
    expect(wrongFormat.scores).toHaveLength(0)
    expect(wrongFormat.notice).toBe('この JSON は bass-tabs の書き出しではありません')
    // 版が違う
    const wrongVersion = await importFile(
      jsonFile(JSON.stringify({ format: 'bass-tabs-library', version: 999, scores: [] })),
    )
    expect(wrongVersion.notice).toBe('対応していない版の書き出しです')
    // JSON ですらない
    const broken = await importFile(jsonFile('{'))
    expect(broken.scores).toHaveLength(0)
    expect(broken.notice).toBe('ファイルを読めませんでした')
  })

  test('importFile は投げない: 読み手が爆発しても通知文になる', async () => {
    // text() が失敗するファイル。呼び出し側に catch を書かせないのが約束
    const exploding = { name: 'x.json', text: () => Promise.reject(new Error('boom')) }
    const outcome = await importFile(exploding as unknown as File)
    expect(outcome.scores).toHaveLength(0)
    expect(outcome.notice).toBe('ファイルを読めませんでした: boom')
  })

  test('画像かどうかは拡張子で見分ける', () => {
    expect(isTabImage('tab.png')).toBe(true)
    expect(isTabImage('TAB.JPEG')).toBe(true)
    expect(isTabImage('score.musicxml')).toBe(false)
    expect(isTabImage('library.json')).toBe(false)
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
