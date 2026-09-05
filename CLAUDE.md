# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A MusicXML viewer whose only job is **producing printable A4 sheet music** for bass practice.
Vite + React + TypeScript, rendering via OpenSheetMusicDisplay (OSMD).

It also has a tab editor, so a score can be written in the app instead of imported — but only as a
way to get something onto paper.

Printing comes first, and playback is second: it started as a proofing tool and has since been
*deliberately re-scoped* (2026-08) into a practice tool — the tab grid highlights the column
being sounded, and clicking a measure number plays from that measure. Follow-along features are
in scope now; section looping and live tempo changes are simply not built yet. The follow-along
happens on the app's own tab grid, never by driving OSMD's cursor over the rendered page — the
page stays a print preview.

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

The only tests are the Playwright specs in `tests/` — `print.spec.ts` for imported files, and
one spec per editor area for scores written in the app (`editor-input`, `library`,
`import-export`, `midi`, `ascii-tab`, `image-import`, `video-import`, `audio`, `playback`, `appearance`, sharing
`tests/helpers.ts`), plus `bundle.spec.ts` for what the first load is allowed to carry; there are no unit tests. `pnpm test:print` runs them all — it builds and
serves the app itself, so it needs no running dev server.

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
  vanishes. `tests/appearance.spec.ts` asserts contrast rather than colour values so a repalette
  is free but a regression is not.

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
  number, down to a dotted 16th (9) -- and it divides by three as well, so triplets (an eighth
  triplet is 8, a 16th triplet 4) needed no change to the grid.

An entry's length is a `Duration` — `value`, `dotted`, `triplet`, the last two exclusive — and
`ticks()` takes the whole thing rather than its fields, so the next attribute reaches all nine
call sites for free. Tuplets are deliberately *not* grouped in the model: `Entry[]` stays flat,
so everything that walks it (`edit.ts`, `playback.ts`, the grid, `measureRemaining`) is
unchanged, and `musicxml.ts` derives the `<tuplet>` brackets from runs of three when it writes.
A partial group is closed with triplet rests there too — the same division of labour as
`padded()`: the model holds what was entered, the serialiser makes it well-formed notation.

A beat (`Note`) holds a `notes` array -- one fingering for a single note, several for a
chord, unique strings, sorted by string number. Clicking a lane of an existing column
*toggles* that string in or out (`toggleNoteAt`); the keyboard and MIDI write single notes
(`putNote`). Removing the last string of a beat leaves a rest, so the rhythm never shifts.
Arrow-key moves act on the whole chord or not at all. A stored score is never discarded over a
shape change: `readScore` walks the one-step lifts (`fromVersion2` onward) from whatever version
it was written at, because people already had scores saved.

Editing is split in three. `edit.ts` holds the score transformations as pure functions (`Score`
in, `Score` out; null means "this edit has nowhere to go") — tested directly in
`tests/editor-input.spec.ts`, the same way playback's `schedule()` is. `useLibrary.ts` owns which
scores exist, which is open, and the localStorage writes. `useEditor.ts` connects the two:
cursor, undo history, and `commit()`. Around them, `useEditorKeyboard.ts` is the tab editor's
keyboard scheme (including the run of digits that makes "1" then "2" fret 12), and
`importFile.ts` maps an imported file — image, library JSON, or MusicXML — to scores plus the
notice to show, never throwing; so `App.tsx` is wiring, not implementation.

Every change to the score goes through `commit()` in `useEditor`, which is also where undo records
its snapshots — so a new mutation must call `commit()` rather than `setScore` directly, or it will
be invisible to undo. Passing the same `CommitKey` as the previous commit extends that step instead
of adding one; that is how a typed title or a two-digit fret stays a single undo.

When the open score changes — a switch, an add, an import, a delete of the open one — everything
in `useEditor` that remembers a position in it (cursor, history, commit key) resets in one place,
keyed on `currentId`. Library operations deliberately carry no resets of their own; a new one
cannot forget to.

The OCR engine is loaded on demand from inside `imageImport.ts`, and that is the only thing
about the bundle worth defending: `tests/bundle.spec.ts` fetches the scripts the page pulls in
and fails if tesseract.js is among them, because hoisting that `await import` to a static one
breaks no feature and no build — it just makes every visitor download the engine. The
recogniser's *own* modules are imported statically on purpose (#79): both the image path and
video mode need them, and splitting them out moves 7 KB out of a 1.5 MB chunk that is almost
all OSMD.

`src/editor/tabImage.ts` + `imageImport.ts` read a screenshot of a tab into a `Score`:
pixel analysis (line detection, glyph clustering — pure, testable) in the former, OCR
orchestration in the latter. tesseract.js and its assets are self-hosted under `public/ocr/`
(lazy-loaded; `.oxlintrc.json` ignores that dir — it is third-party build output). Note values
are deliberately not guessed: everything imports as eighth notes and the editor is the
correction UI. The synthetic-screenshot tests in `tests/image-import.spec.ts` are the spec for what
the analyser must survive (both ink polarities, digits crossing the string lines, chords
refused, the staff inside a busy full-page screenshot, a five-line notation staff nearby).
The staff is found by geometry -- four long, thin, *evenly spaced* lines, tried in both
polarities -- not by whole-image statistics; a global minority-ink guess broke on the first
real screenshot (dark browser UI around a bright video).

`src/components/VideoImport.tsx` is video mode, with two sources. A video *file* is
same-origin, so the scan seeks through it at decode speed and reads each new screenful of tab
once -- `videoScan.ts` holds the pure screen-signature logic (position+strings per beat,
70%-overlap sameness, so a moving playhead does not read as a new screen). Tabs that *scroll*
under a fixed playhead never repeat a screen, so the same file also has `scrolledBeats()`: the
beats appended so far (the `frontier`) are matched against each frame by a common leftward shift
(±1 bucket, ties broken by exactness), and only the beats past the last match and clear of the
right edge (`isWhole`) are OCR'd (`readTabEntries` takes a column subset for this). The scan
tries the frontier first, then the same-screen-twice page path, then the scroll bootstrap -- in
that order, because a static screen also matches itself at shift 0 and must keep the page path
(that is where audio timing lives; scrolled beats get none). The bootstrap reads the *first-seen*
frame, kept as `pendingFrame`, because its leftmost beat may already have left the current one.
Matching ignores frets, so a repeated riff across a page cut can read as a scroll; README says so. A YouTube embed is
cross-origin, so it goes through `getDisplayMedia` capture instead. Both feed the same
recogniser (`readTabEntries`) and append to the open score -- one capture (or one detected
screen), one commit, one undo step. The scan loop outlives many commits, so it reads
`appendEntries` through a ref; the captured prop would append every screen onto the score as
it was when the scan started, and the last screen would silently win. The rendered score is
`hidden` (not unmounted -- OSMD owns the container) while this mode is up, because the capture
films this very tab and staff lines on screen read as false string lines. The OCR worker is a
module-level singleton so repeated captures do not re-download megabytes. Tests stub
`getDisplayMedia` with a canvas `captureStream()` -- the permission prompt is the only part the
real path has that the tests do not.

`src/editor/audio.ts` + `quantize.ts` are the rhythm side of the file scan (#75): pixels say
which notes, the file's own audio track says how long. Both are pure functions over numbers
(no Web Audio -- decoding is the caller's, same split as `playback.ts`/`usePlayback.ts`), tested
against synthesized PCM in `tests/audio.spec.ts`. The policy everywhere is refuse-don't-round:
one grid is estimated for the whole file, a screen gets note values only when its display
window holds exactly one onset per note, and any result the model cannot spell (off-grid,
no such duration, a note across a barline) keeps that screen on the all-eighths import.
"Plausible-looking wrong rhythm" is the failure mode this is built to never produce. Meter and
tempo are deliberately not estimated: 4/4 stays, and `Score.tempo` is never written from a
guess -- it is printed on paper as ♩=N, and a wrong guess would be printed too.

`src/editor/audioImport.ts` is transcription (#76): an audio *file* becomes a score with no
pixels involved -- onsets say when, `pitchAt` (YIN over the same PCM, in audio.ts) says which
note, `positionFor` turns the pitch into the lowest playable fret, and the #75 grid supplies
the lengths when it can. Monophonic bass recordings only: polyphonic pitch is a different
problem and source separation is #61's. YIN reads the period from the waveform rather than
the spectrum's peak because a bass fundamental is often weaker than its harmonics -- the
octave error that would cause is pinned by a dedicated test. An onset whose pitch cannot be
read (or falls outside the tuning) becomes a rest and is counted, same as unreadable OCR
glyphs. `decodeMonoSamples` lives here and VideoImport shares it -- a webm's audio track and
an mp3 are the same thing to `decodeAudioData`.

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

Anything that remembers a position in the score — the undo history, the keyboard's run of
digits — has to be cleared when the open score changes, or it will address the score that was
left. Both reset themselves on the `currentId` seam: the editor's state in `useEditor`, the
digit run in `useEditorKeyboard`. Nothing outside those two files should grow such state without
joining that seam.

The notation staff is written an octave above sounding pitch, as bass parts are. That shift lives
only in `musicxml.ts` (`WRITTEN_OCTAVE_SHIFT`) — `tuning.ts` stays at sounding pitch, which is what
the fret arithmetic and MIDI input are about. The file declares `<transpose>` with
`octave-change: -1` so it still states the real pitch; OSMD ignores that for display, which is what
lets both be true at once. Written at pitch, the open E string needs three ledger lines: measured on
the two-page sample, 201 ledger-line elements against 10.

`src/editor/playback.ts` + `usePlayback.ts` are the playback (再生/一時停止 and 停止 in the
editor panel). The note list is built from the `Score` model directly — never from the MusicXML or the
rendered page — so `WRITTEN_OCTAVE_SHIFT` does not apply and notes sound at real pitch, which is
the point of the shift living only in `musicxml.ts`. `schedule()` is a pure function and is
tested without an AudioContext in `tests/playback.spec.ts`; the hook is the only code touching Web
Audio. Tempo lives on `Score` (`tempo`, quarter-note BPM whatever the meter): it is printed as
♩=N via `tempoXml()` in musicxml.ts, written to the exported file as `<sound tempo>`, read back
by the importer, and changed through `commit()` (one `CommitKey`, so an adjustment is one undo
step). The current `STORAGE_VERSION` lives in `storage.ts` and only there — this file stating a
number has already gone stale twice, so it deliberately doesn't. Playback stops when the open
score changes, per the rule below about remembered positions, and when leaving the editor (in
video mode it would bleed into the capture).

Pause is not a suspended AudioContext: the graph is torn down exactly as a stop tears it down,
and all that is kept is the tick that was sounding (#95). Resuming is `playFrom(thatTick)` — the
same entry point the measure-click head-start uses — so there is one way to start a run, and a
pause survives anything that rebuilds the note list (a tempo change while paused resumes at the
new tempo). Stop is the one that clears the held tick *and* sends the editor cursor back to the
top via `resetCursor()`; like the other cursor moves it does not go through `commit()`, so undo
has nothing to say about it.

`src/editor/midiFile.ts` writes the score as a standard MIDI file. It takes the note list from
`schedule()` rather than building its own, so sounding pitch, chords, triplets and the score's
tuning are already decided by the time it runs. `DIVISIONS` being 24 is what makes this cheap:
SMF's header division *is* ticks per quarter note, so every tick lands in the file unchanged.
Two things it must keep doing — a note-off is written before a note-on at the same tick (a note
ending exactly where the next begins is the common case, and the wrong order silences the new
one), and two strings sounding one pitch collapse to a single note (the model allows E 5th fret
with A open; one MIDI channel does not). Strings and frets do not survive, so the file cannot be
read back as written: importing re-fingers it.

`src/editor/midiImport.ts` reads a `.mid` into a `Score` (`fromMidi(bytes, title)`, pure, so the
round trip through `toMidiFile()` is checked in Node in `tests/midi.spec.ts`). The file holds a
performance and the model holds notation, and the reader refuses to guess: every onset and end
must land on the 24-tick grid once the file's division is scaled (no quantisation — that is #75),
every length must be a value the model has, a note may not cross a barline or overlap the next
beat, a chord's tones must end together, and exactly one track may carry notes. Anything else is
a distinct refusal reason mapped to its notice in `importFile.ts`. Gaps become rests via a
smallest-count fill (`restsFor`), plain before triplet, and a triplet rest takes the value of the
triplet note it borders so `musicxml.ts` groups them. A note below the four-string's E makes the
score five-string. Fingering is re-derived per beat
(`fingeringsFor`): highest pitch first, highest reaching string, backtracking so no string sounds
twice — the invariant `isScore` enforces — because `positionFor` alone puts D2+E2 on one string.
Out-of-range pitches are dropped and counted, as the image import does. `importFile.ts` reads
`.mid`/`.midi` through `arrayBuffer()` before the text path; it is the one binary import.

`src/editor/asciiTab.ts` reads a plain-text ASCII tab (`fromAsciiTab(text, title)`, pure, tested
in `tests/ascii-tab.spec.ts`). It reaches the library two ways that share one path: a `.txt`/`.tab`
through `importFile.ts`, or a paste anywhere in the editor that is not a text field, which `App.tsx`
wraps in a `File` and hands to the same importer -- `isAsciiTab()` is the gate so pasted prose does
nothing. The format has strings, frets and barlines and no note values, so the policy is the one
the image/video/audio imports settled: **do not infer rhythm**. Bars come from `|`, every note in a
bar gets one uniform value (eighths, 16ths past eight notes, refused past sixteen), and the bar is
padded with rests so bar N of the text is bar N of the score. Digits sharing a column (by span
overlap, so a right-aligned `9` under `10` joins) are a chord; a run of digits is one number;
line order is `<string>` order (top line is string 1); five lines make a five-string score, and
labels that spell any other tuning are refused. Technique marks (any character that is not a
digit, dash, bar or space) refuse the whole tab rather than vanish -- a score missing its
hammer-ons looks complete and is not.

MusicXML's two numbering schemes run in opposite directions and are the easiest thing to break:
`<string>` counts from the highest-pitched string (G is 1), `<staff-tuning line>` counts from the
bottom staff line (the lowest string is 1). `tuning.ts` holds the conversion; don't inline the
arithmetic.

Nothing about strings is a module constant: a `Tuning` is data and every function in `tuning.ts`
takes the one it works in, because the tuning belongs to the score (`Score.tuning`, four- or
five-string). That is what lets a library hold both at once and an imported file keep the tuning
it declares. Because `<string>` counts from the top, G–D–A–E keep numbers 1–4 in both tunings —
which is why a four-string tab read from an image lands correctly in a five-string score.
Image and video import stay four-string only: `LANES = 4` in `tabImage.ts` is not a count but the
discriminator that tells a bass tab from a five-line notation staff or a six-string tab, and
loosening it needs a different discriminator first (see README).

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

Three traps:

- A file handed to `setInputFiles` must sit under an **ASCII path**. `testInfo.outputPath()` builds
  its directory from the test title, and these titles are Japanese — Playwright then attaches
  nothing, raises nothing, and the change event never fires, which is indistinguishable from a
  broken handler. The editor specs write import fixtures to a `mkdtempSync` directory instead
  (`asciiFixtureDir` in `tests/helpers.ts`, which carries this warning).


- `page.emulateMedia()` outlives navigation. Leaving it set to `'screen'` makes a later
  `page.pdf()` render with screen styles and report wrong page counts — that looks exactly like a
  pagination bug in the app.
- A print assertion is not automatically a screen assertion (see the third bullet above).

Measured results (OSMD 2.1.2, Chromium 1194) — option names, print scale, TAB support, and
multi-page signature behavior — are recorded in README.md. Update that section when findings change.
