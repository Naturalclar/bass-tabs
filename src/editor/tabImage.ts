/**
 * Finds the tab notation in a screenshot: four string lines with fret numbers
 * sitting on them. This half of the pipeline is pure pixel analysis, knows
 * nothing of OCR -- it returns where the digit groups are, and a cleaned mask to read
 * them from, so the recognition layer can be tested and swapped independently.
 */

/** One fret number to read: a digit group on one string. */
export type TabDigitRegion = {
  /** String number the digits sit on (1 = G, matching the model). */
  string: number
  /** How many digit glyphs the group holds. */
  glyphs: number
  /** Component labels of those glyphs -- the crop stencil. */
  labels: number[]
  /** Bounding box of the digit group, in image pixels. */
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * One beat: the digit groups sharing an x position. One part is a single
 * note; parts on several strings at once are a chord.
 */
export type TabColumnRegion = {
  parts: TabDigitRegion[]
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
      /** Same, before the line erasure -- the fallback crop for OCR. */
      inkOriginal: Uint8Array
      /** Connected-component label per pixel, -1 where the mask is empty. */
      labels: Int32Array
      /** Beats left to right; a column with several parts is a chord. */
      columns: TabColumnRegion[]
    }
  | { ok: false; reason: 'no-lanes' | 'no-notes' }

const LANES = 4

/** Otsu's threshold over a 256-bin histogram of luminance. */
export function otsu(histogram: Uint32Array, total: number): number {
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

type Band = { top: number; bottom: number; ink: number }

/**
 * Rows where ink runs a long way across, merged into thin bands. The width
 * threshold is absolute (a line spans its staff), and a band taller than a
 * dozen pixels is a filled region, not a drawn line -- on a real screenshot
 * the page background around the video binarises into exactly such blocks,
 * and they must not survive to be mistaken for staff lines.
 */
function lineBands(mask: Uint8Array, width: number, height: number): Band[] {
  const rowInk = new Uint32Array(height)
  for (let y = 0; y < height; y++) {
    let count = 0
    for (let x = 0; x < width; x++) count += mask[y * width + x]
    rowInk[y] = count
  }
  const merged: { top: number; bottom: number }[] = []
  for (let y = 0; y < height; y++) {
    if (rowInk[y] < width * 0.4) continue
    const last = merged[merged.length - 1]
    if (last && y <= last.bottom + 2) last.bottom = y
    else merged.push({ top: y, bottom: y })
  }
  return merged
    .filter((band) => band.bottom - band.top + 1 <= 12)
    .map((band) => {
      let ink = 0
      for (let y = band.top; y <= band.bottom; y++) ink += rowInk[y]
      return { ...band, ink: ink / (band.bottom - band.top + 1) }
    })
}

const center = (band: Band) => (band.top + band.bottom) / 2

/**
 * Four evenly spaced bands are a bass tab staff; that geometry is what tells
 * the staff apart from everything else that binarises into long rows.
 * Candidate runs are grown greedily from each starting pair and a run is used
 * only at its full length: a five-line notation staff or a six-string guitar
 * tab contains four evenly spaced lines too, and reading four of six strings
 * would import wrong notes that look right.
 */
function tabLanes(bands: Band[]): Band[] | null {
  const runs: Band[][] = []
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const gap = center(bands[j]) - center(bands[i])
      if (gap < 6) continue
      // Drawn lines land within a pixel or two of even spacing; anything
      // looser is a coincidence across unrelated lines, and a loose
      // tolerance let a run mix a notation staff's lines with the tab's.
      const tolerance = Math.max(3, gap * 0.08)
      const run = [bands[i], bands[j]]
      for (let k = j + 1; k < bands.length; k++) {
        const expected = center(run[run.length - 1]) + gap
        if (Math.abs(center(bands[k]) - expected) <= tolerance) run.push(bands[k])
      }
      if (run.length >= LANES) runs.push(run)
    }
  }
  const contains = (long: Band[], short: Band[]) => short.every((band) => long.includes(band))
  const candidates = runs.filter(
    (run) =>
      run.length === LANES &&
      !runs.some((other) => other.length > LANES && contains(other, run)),
  )
  if (candidates.length === 0) return null
  // Several staffs on screen: the most line-like one (the most ink) wins.
  return candidates.reduce((best, run) =>
    run.reduce((sum, band) => sum + band.ink, 0) > best.reduce((sum, band) => sum + band.ink, 0)
      ? run
      : best,
  )
}

export function analyzeTabImage(image: ImageData): TabImageAnalysis {
  const { width, height, data } = image

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

  // Which side of the threshold is the ink? On a bare tab image the minority
  // side is -- but a screenshot holds dark UI around a bright video (or the
  // other way around), and a global count answers for the wrong region. So
  // both polarities are tried, and the one whose long rows form four evenly
  // spaced lines is the one that was ink.
  let mask: Uint8Array | null = null
  let ink: Uint8Array | null = null
  let lanes: Band[] | null = null
  for (const inkIsDark of [true, false]) {
    const tryMask = new Uint8Array(width * height)
    for (let i = 0; i < luma.length; i++) {
      tryMask[i] = (inkIsDark ? luma[i] <= threshold : luma[i] > threshold) ? 1 : 0
    }
    const tryLanes = tabLanes(lineBands(tryMask, width, height))
    if (!tryLanes) continue
    const better =
      lanes === null ||
      tryLanes.reduce((sum, band) => sum + band.ink, 0) >
        lanes.reduce((sum, band) => sum + band.ink, 0)
    if (better) {
      mask = tryMask
      lanes = tryLanes
      ink = new Uint8Array(width * height)
      for (let i = 0; i < luma.length; i++) ink[i] = inkIsDark ? luma[i] : 255 - luma[i]
    }
  }
  if (!mask || !ink || !lanes) return { ok: false, reason: 'no-lanes' }
  const inkOriginal = ink.slice()

  const bands = lanes
  const laneCenters = bands.map(center)
  const laneGap = (laneCenters[LANES - 1] - laneCenters[0]) / (LANES - 1)

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
    const refill: boolean[] = new Array(width).fill(false)
    for (let x = 0; x < width; x++) {
      // Two rows of slack on each side: the row hugging the band is where a
      // stroke's antialiasing lives, and it can fall on the background side
      // of the threshold -- one row of adjacency then misses real strokes
      // and bites chunks out of the digits.
      const touches = (from: number, to: number) => {
        for (let y = Math.max(0, from); y <= Math.min(height - 1, to); y++) {
          if (mask[y * width + x]) return true
        }
        return false
      }
      refill[x] = touches(band.top - 2, band.top - 1) && touches(band.bottom + 1, band.bottom + 2)
    }
    // A diagonal stroke crosses the band shifted by a pixel, so its own
    // column fails the test and the digit splits in two. Bridge a column
    // when both neighbours qualify -- interior gaps close, but the fill
    // cannot creep sideways past a stroke's edge: a one-pixel bump beside a
    // 1 was enough for OCR to read a phantom digit in front of it.
    const bridged = refill.map(
      (qualifies, x) => qualifies || (refill[x - 1] === true && refill[x + 1] === true),
    )
    for (let x = 0; x < width; x++) refill[x] = bridged[x]
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

  // A digit sitting right on a line can genuinely not cross it -- a 5's
  // waist is empty where the line ran -- so erasing the band cuts it into a
  // top and a bottom piece. Those pieces stack: same columns, a band apart.
  // Rejoin them before any size filtering, or each half is short enough to
  // be thrown away as a speck. The labels array keeps both pieces' labels so
  // the crop stencil still owns every pixel.
  const merged: (Component & { labels: number[] })[] = components.map((component, label) => ({
    ...component,
    labels: [label],
  }))
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 0; i < merged.length && !changed; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i]
        const b = merged[j]
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1
        const widthA = a.x1 - a.x0 + 1
        const widthB = b.x1 - b.x0 + 1
        const verticalGap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1) - 1
        // Strictly stacked (no y overlap, a band-width apart), and of a
        // similar width: half a digit looks like the other half, and nothing
        // like the page-background component that happens to share columns.
        if (verticalGap < 0 || verticalGap > 6) continue
        if (overlap < Math.min(widthA, widthB) * 0.5) continue
        if (Math.max(widthA, widthB) > Math.min(widthA, widthB) * 3) continue
        merged[i] = {
          x0: Math.min(a.x0, b.x0),
          y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1),
          y1: Math.max(a.y1, b.y1),
          area: a.area + b.area,
          labels: [...a.labels, ...b.labels],
        }
        merged.splice(j, 1)
        changed = true
        break
      }
    }
  }

  // A glyph is ink near a lane, inside the staff, and neither speck nor
  // leftover line fragment.
  const glyphs = merged
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
      // Note stems are the other slender shape: a bare vertical stroke under
      // the staff. One at the same x as a real digit on another string read
      // as a chord and refused the whole capture.
      if (glyphHeight > glyphWidth * 5) return false
      // A digit stands a good part of the lane gap tall. Stubs a few pixels
      // high -- the refilled end of an erased line, compression specks --
      // otherwise ride along in a cluster and OCR reads them as extra digits
      // (a 12 came back as 312).
      if (glyphHeight < laneGap * 0.25) return false
      if (glyphHeight > laneGap * 1.5) return false
      // Fret digits sit centred on their line. Overlays hang more digits
      // around the staff -- fingerings above it, tempo below -- and half a
      // gap of slack was enough to adopt them onto the outer strings, where
      // they collided with real notes as phantom chords.
      if (glyph.laneDistance > laneGap * 0.35) return false
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
    // Glyphs sharing an x position but sitting on different strings are one
    // beat played on several strings -- a chord. Each string's digits are
    // still their own OCR crop; only the timing is shared.
    const lanesHere = [...new Set(cluster.map((glyph) => glyph.lane))].sort((a, b) => a - b)
    columns.push({
      parts: lanesHere.map((lane) => {
        const part = cluster.filter((glyph) => glyph.lane === lane)
        return {
          // Lanes are numbered from the top of the staff, and so are strings:
          // the top tab line is G, string 1.
          string: lane + 1,
          glyphs: part.length,
          labels: part.flatMap((glyph) => glyph.labels),
          x0: Math.min(...part.map((glyph) => glyph.x0)),
          y0: Math.min(...part.map((glyph) => glyph.y0)),
          x1: Math.max(...part.map((glyph) => glyph.x1)),
          y1: Math.max(...part.map((glyph) => glyph.y1)),
        }
      }),
    })
  }

  return { ok: true, width, height, mask, ink, inkOriginal, labels, columns }
}
