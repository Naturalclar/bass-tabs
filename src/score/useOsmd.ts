import { useCallback, useEffect, useRef, useState } from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { A4_RENDER_WIDTH_PX, printOsmdOptions } from './osmdOptions'

export type ScoreStatus =
  | { kind: 'empty' }
  | { kind: 'loading'; name: string }
  | { kind: 'ready'; name: string; pages: number }
  | { kind: 'error'; name: string; message: string }

/**
 * OSMD writes one `<svg>` per page with pixel width/height attributes baked in.
 * Those pixels are whatever we happened to render at, which is not what we want
 * on paper. Swapping them for a viewBox makes each page scalable, so CSS can
 * state the real size once (210mm x 297mm in print, fit-to-container on screen)
 * without re-rendering the score.
 */
function makePagesScalable(container: HTMLElement): number {
  const pages = [...container.querySelectorAll('svg')]
  pages.forEach((svg, index) => {
    const width = Number(svg.getAttribute('width'))
    const height = Number(svg.getAttribute('height'))
    if (!svg.hasAttribute('viewBox') && width > 0 && height > 0) {
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    }
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.classList.add('score-page')
    // OSMD puts every page <svg> in its own wrapper <div>, so each one is both
    // the first and the last svg inside its parent. CSS :last-of-type would
    // therefore match every page and cancel the page break on all of them --
    // the break has to be assigned by index instead.
    svg.classList.toggle('score-page--break-after', index < pages.length - 1)
    svg.parentElement?.classList.add('score-page-wrapper')
  })
  return pages.length
}

/**
 * Puts the page back where it was after a re-render. Restoring only when the
 * browser actually moved keeps this from fighting a scroll the person started
 * themselves, and the document may now be shorter, so the browser clamps.
 */
function restoreScroll(scrollY: number): void {
  if (window.scrollY === scrollY) return
  window.scrollTo({ top: scrollY, behavior: 'instant' })
}

export function useOsmd() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const [status, setStatus] = useState<ScoreStatus>({ kind: 'empty' })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const osmd = new OpenSheetMusicDisplay(container, printOsmdOptions)
    osmdRef.current = osmd
    return () => {
      osmdRef.current = null
      osmd.clear()
    }
  }, [])

  const loadScore = useCallback(async (source: Blob | string, name: string) => {
    const osmd = osmdRef.current
    const container = containerRef.current
    if (!osmd || !container) return

    // OSMD tears the whole score DOM down and rebuilds it on every load. While
    // the container is empty the document has nothing holding the scroll
    // offset, so the browser resets it -- and the rebuild restores the height
    // but not the position. Editing is one load per keystroke, so without this
    // the page jumps to the top on every note.
    const scrollY = window.scrollY
    setStatus({ kind: 'loading', name })
    try {
      // OSMD unzips .mxl itself when handed a Blob, so .xml and .mxl take the
      // same path here.
      await osmd.load(source, name)
      // Render at a fixed width so page breaks don't move with the window.
      container.style.width = `${A4_RENDER_WIDTH_PX}px`
      osmd.render()
      container.style.width = ''
      const pages = makePagesScalable(container)
      restoreScroll(scrollY)
      setStatus({ kind: 'ready', name, pages })
    } catch (error) {
      container.replaceChildren()
      restoreScroll(scrollY)
      setStatus({
        kind: 'error',
        name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  return { containerRef, loadScore, status }
}
