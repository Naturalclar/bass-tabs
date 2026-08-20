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
```

There is no test suite. Verification is done by driving the app in Chromium (see below).

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

There is no automated check for "does it print correctly", so verify in a real browser: build,
`npx vite preview`, then drive it with Playwright against `public/samples/` (Chromium is
preinstalled at `/opt/pw-browsers/chromium`; do not run `playwright install`). Generate a PDF with
`page.pdf({ preferCSSPageSize: true })` and assert the page count and the ~210×297mm media box.

One trap: `page.emulateMedia()` outlives navigation. Leaving it set to `'screen'` makes a later
`page.pdf()` render with screen styles and report wrong page counts — that looks exactly like a
pagination bug in the app.

Measured results (OSMD 2.1.2, Chromium 1194) — option names, print scale, TAB support, and
multi-page signature behavior — are recorded in README.md. Update that section when findings change.
