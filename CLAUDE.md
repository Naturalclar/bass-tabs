# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A MusicXML viewer whose only job is **producing printable A4 sheet music** for bass practice.
Vite + React + TypeScript, rendering via OpenSheetMusicDisplay (OSMD).

It also has a tab editor, so a score can be written in the app instead of imported — but only as a
way to get something onto paper.

Explicitly out of scope: playback, cursor following, tempo control, section looping. Anything
"follow along on screen while playing" belongs to a separate alphaTab experiment, not here. A
feature request phrased as "it would be nice while practicing" is usually this, so check before
building it.

## Commands

```sh
pnpm dev        # dev server
pnpm check      # lint + typecheck
pnpm typecheck  # tsc -b --noEmit
pnpm lint       # oxlint
pnpm build      # typecheck, then production build
pnpm test:print # print regression check (builds, serves, prints to PDF)
```

CI runs `lint`, `typecheck` and a build in one job and `test:print` in another, so `pnpm check`
passing is not the same as CI passing — the build and the print checks are not in it.

The only tests are the print checks in `tests/` — `print.spec.ts` for imported files and
`editor.spec.ts` for scores written in the app; there are no unit tests. `pnpm test:print`
builds and serves the app itself, so it needs no running dev server.

## Two non-negotiable technical choices

Both were decided deliberately; don't "simplify" them away.

- **oxlint, not ESLint** — chosen for speed. It does not fully cover type-informed rules, so
  `tsc -b --noEmit` is a separate mandatory step, in `pnpm build`, `pnpm check`, and CI.
  Neither layer alone is sufficient; this has already caught a real error oxlint let through.
- **SVG backend, never Canvas** — Canvas is raster, so it prints with soft note edges. The
  `backend: 'svg'` option in `src/score/osmdOptions.ts` is a print-quality requirement.

## Architecture

The whole app is three moving parts:

- `src/score/osmdOptions.ts` — the print contract in one place: SVG backend, `pageFormat: 'A4_P'`
  so **OSMD does the page breaking**, and the A4-at-96dpi render width.
- `src/score/useOsmd.ts` — owns the OSMD instance and the load/render cycle. Its
  `makePagesScalable()` post-processes OSMD's output DOM; that function is the fragile part of the
  codebase and its comments explain why each step exists. It also restores the scroll position
  around a load: OSMD rebuilds the whole score DOM every time, and an empty container loses the
  browser's scroll offset — which the editor hits on every keystroke.
- `src/index.css` — screen layout plus the `@media print` block. Paper size is stated here once
  (`210mm × 297mm`), which only works because pages carry a `viewBox`. The screen UI is dark at
  every surface it paints, `:root` declares `color-scheme: dark` to match, and **every control
  states its own `color`** — a background without one inherits the UA's near-white control text and
  vanishes. `tests/editor.spec.ts` asserts contrast rather than colour values so a repalette is
  free but a regression is not.

### The editor is a MusicXML generator, not a second renderer

`src/editor/` holds an editable model (`model.ts`), the tab/pitch conversions (`tuning.ts`), and
`musicxml.ts`, which serialises the model to MusicXML. `App.tsx` feeds that string straight into
the same `useOsmd().loadScore()` an imported file goes through, so **the A4 layout, the print CSS,
and the print checks all apply to edited scores for free**. Keep it that way: anything that renders
the editor's output by another path has to re-earn all of that.

Two things constrain `musicxml.ts`:

- Its output shape copies `public/samples/bass-tab.musicxml` — one part, two staves, every event
  written twice with a `<backup>` between. That file is the one the print checks already prove OSMD
  renders; a different shape means re-verifying OSMD's layout from scratch.
- `DIVISIONS` is 24 because that is the smallest value keeping every supported duration a whole
  number, down to a dotted 16th (9).

Every change to the score goes through `commit()` in `useEditor`, which is also where undo records
its snapshots — so a new mutation must call `commit()` rather than `setScore` directly, or it will
be invisible to undo. Passing the same `CommitKey` as the previous commit extends that step instead
of adding one; that is how a typed title or a two-digit fret stays a single undo.

`src/editor/storage.ts` owns the saved scores: one key per score plus an index naming them and
remembering which was open. Per-score keys are what let an edit write only the score being edited —
the app saves on every keystroke, and rewriting the whole library that often would get slower with
every score added. The index holds no titles on purpose; a title would then live in two places and
need keeping in step on every keystroke, so the library is read in full at startup instead and
served from memory after that.

Everything the app reads off a restored score is validated there, because the stored value is the
only input nothing type-checks — it was written by whatever version of the code ran last, and a
shape the app cannot read fails on *every* reload with no way back from the UI. Change `Score` in a
way the validator would still accept (a renamed field, a changed unit) and bump `STORAGE_VERSION`.

Anything that remembers a position in the score — the digit run in `App.tsx`, the undo history —
has to be cleared when the open score changes, or it will address the score that was left.

The notation staff is written an octave above sounding pitch, as bass parts are. That shift lives
only in `musicxml.ts` (`WRITTEN_OCTAVE_SHIFT`) — `tuning.ts` stays at sounding pitch, which is what
the fret arithmetic and MIDI input are about. The file declares `<transpose>` with
`octave-change: -1` so it still states the real pitch; OSMD ignores that for display, which is what
lets both be true at once. Written at pitch, the open E string needs three ledger lines: measured on
the two-page sample, 201 ledger-line elements against 10.

MusicXML's two numbering schemes run in opposite directions and are the easiest thing to break:
`<string>` counts from the highest-pitched string (G is 1), `<staff-tuning line>` counts from the
bottom staff line (low E is 1). `tuning.ts` holds the conversion; don't inline the arithmetic.

Rendering happens at a fixed pixel width on purpose: OSMD lays out in resolution-independent
units, so pinning the width keeps line and page breaks from moving with the window, and CSS
handles display size afterwards.

### Deployment path

The site is a GitHub Pages project site, so it is served from `/bass-tabs/`, not a domain root.
That path lives once in `base-path.ts`; Vite reads it as `base` and the print checks navigate to
it. Don't inline the string in either place — they sit in separate tsconfig projects, so nothing
catches it when only one is updated.

`vite preview` and `vite dev` both redirect the origin root to the base path. GitHub Pages does
not, so tests navigate to the base path rather than relying on that redirect.

### OSMD's DOM shape is load-bearing

OSMD wraps every page `<svg>` in its own `<div>`. Two consequences bit us already and are
documented in README.md under 実装上つまずいた点:

- those wrappers must stay full width, or `viewBox`-sized pages collapse to the 300px replaced-
  element default;
- `:last-of-type` matches *every* page (each is alone in its wrapper), so page breaks are assigned
  by index in JS, not by a CSS selector.

Re-check both after upgrading OSMD.

## Verifying print output

`pnpm test:print` (`tests/print.spec.ts`, Playwright) is the automated half: it builds, serves,
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
