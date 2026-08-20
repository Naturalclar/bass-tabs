# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A MusicXML viewer whose only job is **producing printable A4 sheet music** for bass practice.
Vite + React + TypeScript, rendering via OpenSheetMusicDisplay (OSMD).

Explicitly out of scope: playback, cursor following, tempo control, section looping. Anything
"follow along on screen while playing" belongs to a separate alphaTab experiment, not here. A
feature request phrased as "it would be nice while practicing" is usually this, so check before
building it.

## Commands

```sh
npm run dev        # dev server
npm run check      # lint + typecheck, same as CI
npm run typecheck  # tsc -b --noEmit
npm run lint       # oxlint
npm run build      # typecheck, then production build
npm run test:print # print regression check (builds, serves, prints to PDF)
```

The only tests are the print checks in `tests/`; there are no unit tests. `npm run test:print`
builds and serves the app itself, so it needs no running dev server.

## Two non-negotiable technical choices

Both were decided deliberately; don't "simplify" them away.

- **oxlint, not ESLint** — chosen for speed. It does not fully cover type-informed rules, so
  `tsc -b --noEmit` is a separate mandatory step, in `npm run build`, `npm run check`, and CI.
  Neither layer alone is sufficient; this has already caught a real error oxlint let through.
- **SVG backend, never Canvas** — Canvas is raster, so it prints with soft note edges. The
  `backend: 'svg'` option in `src/score/osmdOptions.ts` is a print-quality requirement.

## Architecture

The whole app is three moving parts:

- `src/score/osmdOptions.ts` — the print contract in one place: SVG backend, `pageFormat: 'A4_P'`
  so **OSMD does the page breaking**, and the A4-at-96dpi render width.
- `src/score/useOsmd.ts` — owns the OSMD instance and the load/render cycle. Its
  `makePagesScalable()` post-processes OSMD's output DOM; that function is the fragile part of the
  codebase and its comments explain why each step exists.
- `src/index.css` — screen layout plus the `@media print` block. Paper size is stated here once
  (`210mm × 297mm`), which only works because pages carry a `viewBox`.

Rendering happens at a fixed pixel width on purpose: OSMD lays out in resolution-independent
units, so pinning the width keeps line and page breaks from moving with the window, and CSS
handles display size afterwards.

### OSMD's DOM shape is load-bearing

OSMD wraps every page `<svg>` in its own `<div>`. Two consequences bit us already and are
documented in README.md under 実装上つまずいた点:

- those wrappers must stay full width, or `viewBox`-sized pages collapse to the 300px replaced-
  element default;
- `:last-of-type` matches *every* page (each is alone in its wrapper), so page breaks are assigned
  by index in JS, not by a CSS selector.

Re-check both after upgrading OSMD.

## Verifying print output

`npm run test:print` (`tests/print.spec.ts`, Playwright) is the automated half: it builds, serves,
opens each file in `public/samples/`, prints to PDF with `page.pdf({ preferCSSPageSize: true })`,
and asserts the page count and the ~210×297mm media box. CI runs it as a separate `print` job.

Chromium is preinstalled at `/opt/pw-browsers/chromium`; **do not run `playwright install`** here.
`@playwright/test` is pinned to an exact version rather than a caret range so the browser build it
expects is the one already on disk.

What the suite deliberately checks, and why each assertion exists — all three were verified by
breaking the code and watching the right test fail:

- **PDF page count and media box** — catches OSMD's per-page wrapper shrinking to fit, which
  repaginates the document (2 pages became 4).
- **`score-page--break-after` on every page but the last, asserted on the DOM** — the page-count
  assertion *cannot* see this one. Each sample is exactly two 297mm pages, so cancelling the break
  still flows to 2 sheets; the class assignment has to be checked structurally.
- **Page width on screen, not just in print** — the 300px collapse is a screen-side bug. In print
  `.score-page` has a fixed `210mm`, so a print-only measurement passes even while the screen
  layout is broken.

Two traps:

- `page.emulateMedia()` outlives navigation. Leaving it set to `'screen'` makes a later
  `page.pdf()` render with screen styles and report wrong page counts — that looks exactly like a
  pagination bug in the app.
- A print assertion is not automatically a screen assertion (see the third bullet above).

Measured results (OSMD 2.1.2, Chromium 1194) — option names, print scale, TAB support, and
multi-page signature behavior — are recorded in README.md. Update that section when findings change.
