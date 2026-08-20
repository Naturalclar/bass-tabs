# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository is **unscaffolded**. As of the initial commit it contains only `README.md`,
`LICENSE` (MIT, Jesse Katsumata), and `.gitignore`. There is no source code, package manifest,
build system, or test suite yet.

Consequences for anyone working here:

- There are no build/lint/test commands to run. Do not assume `npm test`, `npm run build`, etc.
  exist — check for `package.json` first.
- The first substantive task will be choosing a stack and scaffolding it. That choice is not yet
  made, so ask before picking one rather than inferring it.
- Once a toolchain exists, replace this section with the real commands (install, dev server,
  build, lint, single-test invocation) and the architecture notes that matter.

## Intent

Per `README.md`, the project is a collection of bass tabs. The domain is guitar/bass tablature —
expect the core data model to be tab content (notation, tuning, artist/song metadata) rather than
general-purpose application logic.

## Inferable conventions

- `.gitignore` is GitHub's Node template with extra entries for Next.js, Nuxt, Vite, SvelteKit,
  VitePress, Docusaurus, Gatsby, pnpm, and Yarn v3 (`.pnp.*`, `.yarn/*` with the standard
  unignore list). This signals a **JavaScript/TypeScript** project, most likely a web frontend,
  but no package manager or framework is committed — none is locked in yet.
- `.env` and `.env.*` are ignored except `.env.example`; keep a checked-in example when env
  configuration is introduced.
