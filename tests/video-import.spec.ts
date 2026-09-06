import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_PATH } from '../base-path.ts'
import { scrolledBeats, type ScreenBeat } from '../src/editor/videoScan.ts'

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

/**
 * Records a webm in-page: two different tab screens, ~1.6s each. With
 * `withAudio`, beeps land on a 0.3-second grid (♩=100 の 8 分格子) so the
 * rhythm has a knowable right answer: screen A at 0.1 / 0.7 / 1.0 (♩ ♪ ♪),
 * screen B at 2.2 / 2.8 (♩ ♩). Without it the file has no audio track at
 * all, which is what keeps the all-eighths fallback honest.
 */
async function makeVideoFile(
  page: Page,
  path: string,
  options: { audio?: boolean; scroll?: boolean } = {},
) {
  await page.setContent('<body></body>')
  const b64: string = await page.evaluate(async ({ audio = false, scroll = false }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 720
    canvas.height = 220
    const g = canvas.getContext('2d') as CanvasRenderingContext2D
    const lanes = [50, 90, 130, 170]
    const draw = (notes: { lane: number; x: number; text: string }[], playheadX: number) => {
      g.fillStyle = '#181818'
      g.fillRect(0, 0, 720, 220)
      g.fillStyle = '#eee'
      for (const y of lanes) g.fillRect(20, y, 680, 2)
      g.font = '700 24px monospace'
      g.textBaseline = 'middle'
      for (const n of notes) {
        g.fillStyle = '#181818'
        g.fillRect(n.x - 2, lanes[n.lane] - 12, g.measureText(n.text).width + 4, 26)
        g.fillStyle = '#eee'
        g.fillText(n.text, n.x, lanes[n.lane] + 1)
      }
      // moving playhead: same screen, changing pixels
      g.fillStyle = '#3a3'
      g.fillRect(playheadX, lanes[0] - 12, 6, lanes[3] - lanes[0] + 24)
    }
    const screenA = [
      { lane: 3, x: 80, text: '3' },
      { lane: 2, x: 240, text: '5' },
      { lane: 1, x: 400, text: '0' },
    ]
    const screenB = [
      { lane: 0, x: 120, text: '12' },
      { lane: 3, x: 300, text: '7' },
    ]
    // One long line, 12 beats 100px apart, that scrolls left at 200px/s
    // under a fixed playhead. About seven beats are in view at a time.
    const line = ['3', '5', '0', '12', '7', '10', '3', '5', '0', '12', '7', '10'].map(
      (text, i) => ({ lane: [3, 2, 1, 0, 3, 1, 2, 0, 3, 0, 1, 2][i], x: 80 + i * 100, text }),
    )
    const stream = canvas.captureStream(10)
    let audioContext: AudioContext | null = null
    if (audio) {
      audioContext = new AudioContext()
      await audioContext.resume()
      const destination = audioContext.createMediaStreamDestination()
      const base = audioContext.currentTime + 0.05
      for (const at of [0.1, 0.7, 1.0, 2.2, 2.8]) {
        const oscillator = audioContext.createOscillator()
        oscillator.frequency.value = 220
        const gain = audioContext.createGain()
        gain.gain.setValueAtTime(0.8, base + at)
        gain.gain.exponentialRampToValueAtTime(0.001, base + at + 0.25)
        oscillator.connect(gain).connect(destination)
        oscillator.start(base + at)
        oscillator.stop(base + at + 0.3)
      }
      stream.addTrack(destination.stream.getAudioTracks()[0])
    }
    const recorder = new MediaRecorder(stream, {
      mimeType: audio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8',
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => chunks.push(e.data)
    const doneRecording = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    recorder.start(100)
    const start = performance.now()
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = performance.now() - start
        if (scroll) {
          draw(
            line.map((n) => ({ ...n, x: n.x - (t / 1000) * 200 })).filter((n) => n.x > -40),
            360,
          )
        } else if (t < 1600) draw(screenA, 40 + (t / 1600) * 600)
        else draw(screenB, 40 + ((t - 1600) / 1600) * 600)
        if (t < (scroll ? 4000 : 3200)) requestAnimationFrame(tick)
        else resolve()
      }
      tick()
    })
    recorder.stop()
    await doneRecording
    await audioContext?.close()
    const blob = new Blob(chunks, { type: 'video/webm' })
    const buffer = await blob.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }, options)
  writeFileSync(path, Buffer.from(b64, 'base64'))
}

  const gridNotes = (page: Page) =>
    page
      .locator('.tab-cell--note')
      .evaluateAll((cells) =>
        cells.map(
          (cell) => (cell.getAttribute('aria-label') ?? '').match(/([GDAE]) 弦/)?.[1] + cell.textContent,
        ),
      )

  /**
   * A video *file* needs no screen share: its frames are same-origin, so 走査
   * can seek through the whole thing, spot each new screenful of tab, and
   * read it once. The fixture is recorded right here -- two screens with a
   * moving playhead, so consecutive frames of one screen are never
   * pixel-identical and the dedup has something real to prove.
   */
  test('動画ファイルの走査が画面ごとに一度ずつ読んで追記する', async ({ page }) => {
    test.setTimeout(180_000)
    const file = join(mkdtempSync(join(tmpdir(), 'bass-tabs-vid-')), 'tab.webm')
    await makeVideoFile(page, file)

    await page.goto(BASE_PATH)
    await page.locator('.tab-editor').waitFor()
    await page.getByRole('button', { name: '動画から取り込む' }).click()
    await page.locator('.video-import input[type="file"]').setInputFiles(file)
    await page.locator('video.video-import__player').waitFor()

    await page.getByRole('button', { name: '動画を走査して全部読み取る' }).click()
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.video-import__notice')?.textContent ?? ''
        return text.includes('取り込みました') || text.includes('見つかりませんでした')
      },
      undefined,
      { timeout: 150_000 },
    )
    // Two screens, five notes -- each screen once, despite being sampled
    // several times, and in the order they appear in the video.
    await expect(page.locator('.video-import__notice')).toContainText('2 画面から 5 音')
    // No audio track in this fixture, so the honest fallback holds: no
    // rhythm is guessed and everything stays an eighth note.
    await expect(page.locator('.video-import__notice')).toContainText('音価はエディタで直してください')

    await page.getByRole('button', { name: '譜面を作る' }).click()
    expect(await gridNotes(page)).toEqual(['E3', 'A5', 'D0', 'G12', 'E7'])
    // slice: 埋まりきらない小節は末尾に追加スロット (+) を出す
    const values = await page.locator('.tab-column__value').allTextContents()
    expect(values.slice(0, 5)).toEqual(['♪', '♪', '♪', '♪', '♪'])
  })

  /**
   * #75: the file's audio decides the note values. One grid is estimated
   * for the whole file; per screen, the onsets inside its display window
   * stand in for its notes, and the counts agree here -- so both screens
   * get their rhythm instead of the all-eighths default.
   */
  /**
   * The other kind of video: one long line that scrolls under a fixed
   * playhead. No two sampled frames are the same screen, so the page-by-page
   * dedup never fires; the scan has to recognise the line moving and read
   * only what came into view. Twelve beats, about seven in view at once,
   * each expected exactly once and in order.
   */
  test('横に流れるタブ譜は、流れてきた拍だけを一度ずつ読む', async ({ page }) => {
    test.setTimeout(180_000)
    const file = join(mkdtempSync(join(tmpdir(), 'bass-tabs-vid-')), 'scroll.webm')
    await makeVideoFile(page, file, { scroll: true })

    await page.goto(BASE_PATH)
    await page.locator('.tab-editor').waitFor()
    await page.getByRole('button', { name: '動画から取り込む' }).click()
    await page.locator('.video-import input[type="file"]').setInputFiles(file)
    await page.locator('video.video-import__player').waitFor()

    await page.getByRole('button', { name: '動画を走査して全部読み取る' }).click()
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.video-import__notice')?.textContent ?? ''
        return text.includes('取り込みました') || text.includes('見つかりませんでした')
      },
      undefined,
      { timeout: 150_000 },
    )
    await expect(page.locator('.video-import__notice')).toContainText('流れてきた')
    await expect(page.locator('.video-import__notice')).toContainText('12 音')

    await page.getByRole('button', { name: '譜面を作る' }).click()
    expect(await gridNotes(page)).toEqual([
      'E3', 'A5', 'D0', 'G12', 'E7', 'D10', 'A3', 'G5', 'E0', 'G12', 'D7', 'A10',
    ])
  })

  test('走査は音の長さを音声から推定する', async ({ page }) => {
    test.setTimeout(180_000)
    const file = join(mkdtempSync(join(tmpdir(), 'bass-tabs-vid-')), 'tab.webm')
    await makeVideoFile(page, file, { audio: true })

    await page.goto(BASE_PATH)
    await page.locator('.tab-editor').waitFor()
    await page.getByRole('button', { name: '動画から取り込む' }).click()
    await page.locator('.video-import input[type="file"]').setInputFiles(file)
    await page.locator('video.video-import__player').waitFor()

    await page.getByRole('button', { name: '動画を走査して全部読み取る' }).click()
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.video-import__notice')?.textContent ?? ''
        return text.includes('取り込みました') || text.includes('見つかりませんでした')
      },
      undefined,
      { timeout: 150_000 },
    )
    await expect(page.locator('.video-import__notice')).toContainText('2 画面から 5 音')
    await expect(page.locator('.video-import__notice')).toContainText('音の長さは音声から推定しました')

    await page.getByRole('button', { name: '譜面を作る' }).click()
    // The frets come from the pixels, the lengths from the beeps: screen A
    // is ♩ ♪ ♪ (the last note inherits the gap before it), screen B ♩ ♩.
    expect(await gridNotes(page)).toEqual(['E3', 'A5', 'D0', 'G12', 'E7'])
    expect(await page.locator('.tab-column__value').allTextContents()).toEqual([
      '♩', '♪', '♪', '♩', '♩',
    ])
  })

  test('動画ファイルでは共有なしで「今の画面」を読める', async ({ page }) => {
    test.setTimeout(120_000)
    const file = join(mkdtempSync(join(tmpdir(), 'bass-tabs-vid-')), 'tab.webm')
    await makeVideoFile(page, file)

    await page.goto(BASE_PATH)
    await page.locator('.tab-editor').waitFor()
    await page.getByRole('button', { name: '動画から取り込む' }).click()
    await page.locator('.video-import input[type="file"]').setInputFiles(file)
    await page.locator('video.video-import__player').waitFor()
    // Paused at the head: the current frame is screen A.
    await page.waitForFunction(() => {
      const video = document.querySelector('video.video-import__player') as HTMLVideoElement | null
      return (video?.videoWidth ?? 0) > 0
    })

    await page.getByRole('button', { name: '今の画面を読み取る' }).click()
    await page.waitForFunction(
      () =>
        !document.querySelector('.video-import__notice')?.textContent?.includes('読み取っています'),
      undefined,
      { timeout: 90_000 },
    )
    await expect(page.locator('.video-import__notice')).toContainText('3 音を譜面の末尾に足しました')
  })

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

/**
 * The shift matcher behind the scrolling scan, checked directly: it is pure,
 * and the video test above can only say "12 notes came out", not why.
 */
test.describe('流れるタブ譜の拍の突き合わせ', () => {
  const beat = (strings: string, bucket: number): ScreenBeat => ({ strings, bucket })
  const line = [beat('4', 5), beat('3', 11), beat('2', 17), beat('1', 23), beat('4', 29), beat('2', 35)]
  const shifted = (by: number, extra: ScreenBeat[] = []) =>
    [...line.map((b) => beat(b.strings, b.bucket - by)).filter((b) => b.bucket >= 0), ...extra]

  test('同じ列が左へずれていれば、最後に一致した拍より右の拍だけが新しい', () => {
    const current = shifted(6, [beat('3', 35), beat('1', 41)])
    const result = scrolledBeats(line, current)
    expect(result?.shift).toBe(6)
    // 3 弦@35 は新顔。1 弦@41 は右端にかかっているのでまだ読まない
    expect(result?.fresh).toEqual([current.length - 2])
  })

  test('1 目盛のぶれは同じ拍として数える', () => {
    const jittered = line.map((b, i) => beat(b.strings, b.bucket - 6 + (i % 2)))
    const result = scrolledBeats(line, jittered)
    expect(result?.matched).toEqual(line.map(() => true))
    // 半分が -6、半分が -5 なので、どちらも同じだけ正確
    expect([5, 6]).toContain(result?.shift)
  })

  test('ずらしても揃わなければ別の画面（切り替わり）', () => {
    const other = [beat('1', 4), beat('1', 12), beat('3', 20), beat('2', 28), beat('4', 36)]
    expect(scrolledBeats(line, other)).toBeNull()
    // 3 拍未満の一致は偶然と見なす
    expect(scrolledBeats(line.slice(0, 2), shifted(6).slice(0, 2))).toBeNull()
  })

  test('ずれ 0 で拍が増えるだけの画面（弾いた音が現れていく形式）も新しい拍を返す', () => {
    const result = scrolledBeats(line.slice(0, 4), [...line.slice(0, 4), beat('3', 30)])
    expect(result?.shift).toBe(0)
    expect(result?.fresh).toEqual([4])
  })

  test('前の画面が再生ヘッドで 1 拍隠れていても、その右の拍は新しいと分かる', () => {
    // 前フレームで 2 弦@17 が隠れていた（frontier に無い）。今のフレームでは見えている
    const previous = line.filter((b) => b.bucket !== 17)
    const current = shifted(6, [beat('3', 35)])
    const result = scrolledBeats(previous, current)
    // 隠れていた拍は「最後に一致した拍」より左なので新顔扱いにはならない
    expect(result?.fresh).toEqual([current.length - 1])
  })
})
