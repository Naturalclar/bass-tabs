import { MAX_MEASURES, measureRemaining, type Entry, type Score } from './model.ts'
import { MAX_FRET } from './tuning.ts'
import { analyzeTabImage } from './tabImage.ts'

/**
 * Reads a screenshot of a tab into a Score: pixel analysis finds the digit
 * groups (tabImage.ts), tesseract reads each group, and the notes land left to
 * right as eighth notes. Note values are not guessed -- a wrong rhythm that
 * looks finished is worse than a draft that is obviously one, and the editor
 * is the correction UI.
 *
 * A group the OCR cannot read becomes a rest rather than disappearing: a gap
 * someone can see and fix beats a note silently missing from the middle of a
 * line. The caller is told how many so it can say so.
 */

export type ImageImport =
  | { ok: true; score: Score; unread: number }
  | { ok: false; reason: 'unreadable' | 'no-lanes' | 'chord' | 'no-notes' | 'too-long' }

/** All OCR assets are served by this site itself: no CDN at runtime. */
const OCR_BASE = `${import.meta.env.BASE_URL}ocr/`

const IMPORT_VALUE = 8

async function imageDataOf(file: File): Promise<ImageData | null> {
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, bitmap.width, bitmap.height)
  } catch {
    return null
  }
}

/**
 * The glyph pixels redrawn black on white, scaled up: OCR sees the same clean
 * input whatever the screenshot's colours, compression noise or background were.
 */
function cropForOcr(
  analysis: { mask: Uint8Array; ink: Uint8Array; width: number; height: number },
  region: { x0: number; y0: number; x1: number; y1: number },
): HTMLCanvasElement {
  const SCALE = 4
  const MARGIN = 16
  const { mask, ink, width, height } = analysis
  const cropWidth = region.x1 - region.x0 + 1
  const cropHeight = region.y1 - region.y0 + 1

  // The glyph's own pixels with their antialiased edges, everything else
  // white. The mask says which pixels belong to the glyph; dilating it by two
  // brings the soft fringe back in, because the recogniser was trained on
  // print, not on hard binary edges. The line was erased from the mask, so it
  // stays out however the digits sat on it.
  const small = document.createElement('canvas')
  small.width = cropWidth
  small.height = cropHeight
  const smallContext = small.getContext('2d') as CanvasRenderingContext2D
  const pixels = smallContext.createImageData(cropWidth, cropHeight)
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const sourceX = region.x0 + x
      const sourceY = region.y0 + y
      let near = false
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2 && !near; dx++) {
          const nx = sourceX + dx
          const ny = sourceY + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          if (mask[ny * width + nx]) near = true
        }
      }
      const value = near ? ink[sourceY * width + sourceX] : 255
      const offset = (y * cropWidth + x) * 4
      pixels.data[offset] = value
      pixels.data[offset + 1] = value
      pixels.data[offset + 2] = value
      pixels.data[offset + 3] = 255
    }
  }
  smallContext.putImageData(pixels, 0, 0)

  const canvas = document.createElement('canvas')
  canvas.width = cropWidth * SCALE + MARGIN * 2
  canvas.height = cropHeight * SCALE + MARGIN * 2
  const context = canvas.getContext('2d') as CanvasRenderingContext2D
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(small, MARGIN, MARGIN, cropWidth * SCALE, cropHeight * SCALE)
  return canvas
}

/** Entries laid into bars, growing a bar whenever the next entry won't fit. */
function intoMeasures(entries: Entry[], score: Omit<Score, 'measures'>): Entry[][] {
  const measures: Entry[][] = [[]]
  for (const entry of entries) {
    const current = measures[measures.length - 1]
    if (measureRemaining([...current, entry], score.time) >= 0) current.push(entry)
    else measures.push([entry])
  }
  return measures
}

export type TabEntriesResult =
  | { ok: true; entries: Entry[]; unread: number }
  | { ok: false; reason: 'no-lanes' | 'chord' | 'no-notes' }

/**
 * One OCR worker for the whole session, created on first use. A video-mode
 * capture reads every few seconds; re-downloading megabytes of engine for
 * each would make the wait be mostly setup.
 */
let sharedWorker: Promise<import('tesseract.js').Worker> | null = null

function ocrWorker() {
  sharedWorker ??= (async () => {
    // Loaded on demand: the OCR engine is megabytes, and most visits never
    // import an image.
    const { createWorker, PSM } = await import('tesseract.js')
    const worker = await createWorker('eng', 1, {
      workerPath: `${OCR_BASE}worker.min.js`,
      corePath: `${OCR_BASE}tesseract-core-simd-lstm.wasm.js`,
      langPath: OCR_BASE,
    })
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      // Each crop is one fret number on its own.
      tessedit_pageseg_mode: PSM.SINGLE_WORD,
    })
    return worker
  })()
  return sharedWorker
}

/** Pixel analysis plus OCR: an image becomes eighth-note entries. */
export async function readTabEntries(image: ImageData): Promise<TabEntriesResult> {
  const analysis = analyzeTabImage(image)
  if (!analysis.ok) return { ok: false, reason: analysis.reason }

  const { PSM } = await import('tesseract.js')
  const worker = await ocrWorker()
  const entries: Entry[] = []
  let unread = 0
  const read = async (crop: HTMLCanvasElement): Promise<number> => {
    const result = await worker.recognize(crop)
    return Number(result.data.text.trim())
  }
  const isFret = (value: number) => Number.isInteger(value) && value >= 0 && value <= MAX_FRET
  for (const column of analysis.columns) {
    const crop = cropForOcr(analysis, column)
    let fret = await read(crop)
    // A single tight glyph sometimes comes back empty in word mode -- a
    // bold 0 whose counter is nearly closed, for one. Only then is it worth
    // a second look in single-character mode; a *wrong* first answer gives
    // no such signal, so this is a retry on silence, not a vote.
    if (!isFret(fret) && column.glyphs === 1) {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_CHAR })
      fret = await read(crop)
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_WORD })
    }
    if (isFret(fret)) {
      entries.push({ kind: 'note', string: column.string, fret, value: IMPORT_VALUE, dotted: false })
    } else {
      unread++
      entries.push({ kind: 'rest', value: IMPORT_VALUE, dotted: false })
    }
  }
  return { ok: true, entries, unread }
}

export async function fromTabImage(file: File, title: string): Promise<ImageImport> {
  const image = await imageDataOf(file)
  if (!image) return { ok: false, reason: 'unreadable' }

  const result = await readTabEntries(image)
  if (!result.ok) return { ok: false, reason: result.reason }

  const base = { title, time: { beats: 4, beatType: 4 }, keyFifths: 0 }
  const measures = intoMeasures(result.entries, base)
  if (measures.length > MAX_MEASURES) return { ok: false, reason: 'too-long' }
  return { ok: true, score: { ...base, measures }, unread: result.unread }
}
