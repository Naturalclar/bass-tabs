/**
 * Finds the tab notation in a screenshot: four string lines with fret numbers
 * sitting on them. This half of the pipeline is pure pixel analysis, knows
 * nothing of OCR -- it returns where the digit groups are, and a cleaned mask to read
 * them from, so the recognition layer can be tested and swapped independently.
 */

export type TabColumnRegion = {
  /** String number the digits sit on (1 = G, matching the model). */
  string: number
  /** How many digit glyphs the group holds. */
  glyphs: number
  /** Bounding box of the digit group, in image pixels. */
  x0: number
  y0: number
  x1: number
  y1: number
}

export type TabImageAnalysis =
  | {
      ok: true
      width: number
      height: number
      /** 1 = glyph pixel, after the string lines have been erased. */
      mask: Uint8Array
      /** Luminance normalised to dark-ink-on-white, antialiasing intact. */
      ink: Uint8Array
      /** Digit groups left to right, each on exactly one string. */
      columns: TabColumnRegion[]
    }
  | { ok: false; reason: 'no-lanes' | 'chord' | 'no-notes' }

const LANES = 4

/** Otsu's threshold over a 256-bin histogram of luminance. */
function otsu(histogram: Uint32Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * histogram[i]
  let sumBackground = 0
  let weightBackground = 0
  let best = 0
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t]
    if (weightBackground === 0) continue
    const weightForeground = total - weightBackground
    if (weightForeground === 0) break
    sumBackground += t * histogram[t]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

export function analyzeTabImage(image: ImageData): TabImageAnalysis {
  const { width, height, data } = image

  // Luminance, then Otsu. The tab's ink (lines and digits) is the minority
  // colour whichever way the video is styled, so foreground is whichever side
  // of the threshold has fewer pixels -- that is what makes white-on-black
  // overlays and black-on-white pages the same image from here on.
  const luma = new Uint8Array(width * height)
  const histogram = new Uint32Array(256)
  for (let i = 0; i < width * height; i++) {
    const value = Math.round(
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2],
    )
    luma[i] = value
    histogram[value]++
  }
  const threshold = otsu(histogram, width * height)
  let darkCount = 0
  for (let i = 0; i < luma.length; i++) if (luma[i] <= threshold) darkCount++
  const inkIsDark = darkCount <= luma.length / 2
  const mask = new Uint8Array(width * height)
  const ink = new Uint8Array(width * height)
  for (let i = 0; i < luma.length; i++) {
    mask[i] = (inkIsDark ? luma[i] <= threshold : luma[i] > threshold) ? 1 : 0
    ink[i] = inkIsDark ? luma[i] : 255 - luma[i]
  }

  // String lines: rows where ink runs most of the way across. Adjacent line
  // rows merge into one band per string.
  const rowInk = new Uint32Array(height)
  for (let y = 0; y < height; y++) {
    let count = 0
    for (let x = 0; x < width; x++) count += mask[y * width + x]
    rowInk[y] = count
  }
  let maxRow = 0
  for (let y = 0; y < height; y++) maxRow = Math.max(maxRow, rowInk[y])
  const isLineRow = (y: number) => rowInk[y] >= maxRow * 0.6 && rowInk[y] >= width * 0.3
  const bands: { top: number; bottom: number }[] = []
  for (let y = 0; y < height; y++) {
    if (!isLineRow(y)) continue
    const last = bands[bands.length - 1]
    if (last && y <= last.bottom + 2) last.bottom = y
    else bands.push({ top: y, bottom: y })
  }
  if (bands.length !== LANES) return { ok: false, reason: 'no-lanes' }
  const laneCenters = bands.map((band) => (band.top + band.bottom) / 2)
  const laneGap =
    (laneCenters[LANES - 1] - laneCenters[0]) / (LANES - 1)

  // The tab's horizontal extent is where the lines actually are; digits from
  // the rest of the screenshot (titles, UI) have no lane under them and are
  // dropped later by the vertical test, but this keeps stray marks beside the
  // staff out too.
  let tabX0 = width
  let tabX1 = 0
  for (const band of bands) {
    for (let y = band.top; y <= band.bottom; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x]) {
          if (x < tabX0) tabX0 = x
          if (x > tabX1) tabX1 = x
        }
      }
    }
  }

  // Erase the lines, then rebuild the digit strokes that crossed them. The
  // first idea -- keep band pixels where ink sits above and below -- fails on
  // digits that are wide at both top and bottom (a 2, a 0): everything
  // between counts as "crossing" and the whole line survives as a
  // strikethrough that OCR cannot read past. So: erase the band completely,
  // and refill only column by column where ink touches the band edge on both
  // sides within a pixel -- that is a near-vertical stroke, and a stroke is
  // the only thing that legitimately continues through a line.
  for (const band of bands) {
    const rowAbove = Math.max(0, band.top - 1)
    const rowBelow = Math.min(height - 1, band.bottom + 1)
    const refill: boolean[] = new Array(width).fill(false)
    for (let x = 0; x < width; x++) {
      const touches = (row: number) => {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx >= 0 && nx < width && mask[row * width + nx]) return true
        }
        return false
      }
      refill[x] = touches(rowAbove) && touches(rowBelow)
    }
    for (let x = 0; x < width; x++) {
      for (let y = band.top; y <= band.bottom; y++) {
        mask[y * width + x] = refill[x] ? 1 : 0
        // The ink copy must forget the line too: the OCR crop reads ink
        // around every mask pixel, and a line remembered here comes back as
        // a strikethrough however clean the mask is.
        if (refill[x]) ink[y * width + x] = Math.min(ink[y * width + x], 64)
        else ink[y * width + x] = 255
      }
    }
  }

  // Connected components over what is left: the digit glyphs.
  type Component = { x0: number; y0: number; x1: number; y1: number; area: number }
  const labels = new Int32Array(width * height).fill(-1)
  const components: Component[] = []
  const stack: number[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue
    const label = components.length
    const component: Component = {
      x0: width,
      y0: height,
      x1: 0,
      y1: 0,
      area: 0,
    }
    stack.push(start)
    labels[start] = label
    while (stack.length > 0) {
      const index = stack.pop() as number
      const x = index % width
      const y = (index - x) / width
      component.area++
      if (x < component.x0) component.x0 = x
      if (x > component.x1) component.x1 = x
      if (y < component.y0) component.y0 = y
      if (y > component.y1) component.y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const ni = ny * width + nx
          if (mask[ni] && labels[ni] === -1) {
            labels[ni] = label
            stack.push(ni)
          }
        }
      }
    }
    components.push(component)
  }

  // A glyph is ink near a lane, inside the staff, and neither speck nor
  // leftover line fragment.
  const glyphs = components
    .map((component) => {
      const centerY = (component.y0 + component.y1) / 2
      let lane = 0
      for (let i = 1; i < LANES; i++) {
        if (Math.abs(laneCenters[i] - centerY) < Math.abs(laneCenters[lane] - centerY)) lane = i
      }
      return { ...component, lane, laneDistance: Math.abs(laneCenters[lane] - centerY) }
    })
    .filter((glyph) => {
      if (glyph.area < 4) return false
      const glyphWidth = glyph.x1 - glyph.x0 + 1
      const glyphHeight = glyph.y1 - glyph.y0 + 1
      // Line leftovers are far wider than tall; digits never are.
      if (glyphWidth > glyphHeight * 4) return false
      if (glyphHeight > laneGap * 1.5) return false
      if (glyph.laneDistance > laneGap * 0.75) return false
      if (glyph.x1 < tabX0 || glyph.x0 > tabX1) return false
      return true
    })
  if (glyphs.length === 0) return { ok: false, reason: 'no-notes' }

  // Digits of one fret number sit close together; separate beats sit apart.
  // Cluster on horizontal gaps relative to the typical glyph width.
  glyphs.sort((a, b) => a.x0 - b.x0)
  const widths = glyphs.map((glyph) => glyph.x1 - glyph.x0 + 1).sort((a, b) => a - b)
  const medianWidth = widths[Math.floor(widths.length / 2)]
  const clusters: (typeof glyphs)[] = []
  for (const glyph of glyphs) {
    const cluster = clusters[clusters.length - 1]
    const last = cluster?.[cluster.length - 1]
    if (last && glyph.x0 - last.x1 <= Math.max(3, medianWidth * 0.6)) cluster.push(glyph)
    else clusters.push([glyph])
  }

  const columns: TabColumnRegion[] = []
  for (const cluster of clusters) {
    // Two strings sounding at once is a chord, which the model cannot hold;
    // refusing beats importing something that looks like the tab but is not.
    if (new Set(cluster.map((glyph) => glyph.lane)).size > 1) {
      return { ok: false, reason: 'chord' }
    }
    columns.push({
      // Lanes are numbered from the top of the staff, and so are strings:
      // the top tab line is G, string 1.
      string: cluster[0].lane + 1,
      glyphs: cluster.length,
      x0: Math.min(...cluster.map((glyph) => glyph.x0)),
      y0: Math.min(...cluster.map((glyph) => glyph.y0)),
      x1: Math.max(...cluster.map((glyph) => glyph.x1)),
      y1: Math.max(...cluster.map((glyph) => glyph.y1)),
    })
  }

  return { ok: true, width, height, mask, ink, columns }
}
