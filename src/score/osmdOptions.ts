import type { IOSMDOptions } from 'opensheetmusicdisplay'

/**
 * A4 portrait at 96 CSS dpi. OSMD lays out in resolution-independent units and
 * only uses the container width to pick the unit->pixel zoom, so rendering at a
 * fixed width keeps the layout (line breaks, page breaks) identical regardless
 * of window size. Print size is then set purely in CSS via `mm`.
 */
export const A4_RENDER_WIDTH_PX = Math.round((210 / 25.4) * 96) // 794
export const A4_ASPECT = 297 / 210

/**
 * Options tuned for print output. The two that matter most:
 *
 * - `backend: SVG` — Canvas is a raster target, so note edges resample to the
 *   screen's DPI and print soft. SVG is handed to the printer as vectors.
 * - `pageFormat: 'A4_P'` — makes OSMD do the page breaking itself. Leaving it
 *   at the default ('Endless') produces one tall page and lets CSS cut systems
 *   in half at the paper boundary.
 */
export const printOsmdOptions: IOSMDOptions = {
  // `backend` is typed as a plain string in OSMD 2.1.2; the BackendType enum is
  // numeric and does not assign to it. Anything other than 'svg'/'SVG'/undefined
  // selects Canvas.
  backend: 'svg',
  pageFormat: 'A4_P',
  pageBackgroundColor: '#FFFFFF',
  // We size the container ourselves; autoResize would re-render (and refight
  // our fixed width) on every window resize.
  autoResize: false,
  drawingParameters: 'default',
  // No playback in this app, so the cursor element is dead weight.
  disableCursor: true,
  drawTitle: true,
  drawSubtitle: true,
  drawComposer: true,
  drawCredits: false,
  drawPartNames: true,
}
