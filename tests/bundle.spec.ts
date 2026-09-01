import { test, expect } from '@playwright/test'
import { BASE_PATH } from '../base-path.ts'

/**
 * What the first load is allowed to carry.
 *
 * The OCR engine is megabytes and most visits never import an image, so it is
 * loaded on demand inside `imageImport.ts`. Nothing enforces that: hoisting
 * the `await import('tesseract.js')` to a static import looks harmless, breaks
 * no feature, and quietly moves the engine into the chunk every visitor
 * downloads. The build cannot see the difference either -- it emits a chunk
 * either way. So the check is here, against what the server actually serves.
 *
 * The recogniser's own code (`imageImport.ts` + `tabImage.ts`) is deliberately
 * *not* deferred; splitting it moves 7 KB out of a 1.5 MB chunk that is almost
 * all OSMD, which is not worth the indirection (#79).
 */
test('OCR エンジンは初回ロードのチャンクに入らない', async ({ page, request }) => {
  await page.goto(BASE_PATH)
  await page.locator('.tab-editor').waitFor()

  // The scripts the page itself pulls in -- what a first visit pays for.
  const sources = await page
    .locator('script[src]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLScriptElement).src))
  expect(sources.length).toBeGreaterThan(0)

  const carrying: string[] = []
  for (const src of sources) {
    const body = await (await request.get(src)).text()
    // `OEM` is tesseract.js's own enum, present only where the library is.
    // Our call site mentions `createWorker`, so that name proves nothing.
    //
    // Asserting on the *names* rather than on the bodies: a failing
    // `not.toContain` on a 1.5 MB bundle prints the whole bundle, which
    // buries the one line that says what broke.
    if (body.includes('OEM')) carrying.push(new URL(src).pathname)
  }
  expect(carrying, 'first-load scripts carrying the OCR engine').toEqual([])
})
