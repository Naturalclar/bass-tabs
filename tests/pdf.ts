/**
 * Reading Chromium's own PDF output, shared by every check that prints.
 *
 * Both readers lean on how Chromium writes the file -- an uncompressed page
 * tree, a `/MediaBox` in points -- so they are the part most likely to need
 * fixing when the browser changes. Keeping one copy is what stops that fix
 * from landing in one spec and not the other, with both suites still green.
 */

const MM_PER_PT = 25.4 / 72

/**
 * Chromium writes an uncompressed page tree, so the page objects can be counted
 * without a PDF library. `/Type /Page` must not match `/Type /Pages` (the tree
 * root), hence the lookahead.
 */
export function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

/** First /MediaBox in the file, converted to millimetres. */
export function pdfPageSizeMm(pdf: Buffer): { width: number; height: number } {
  const box = pdf
    .toString('latin1')
    .match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/)
  if (!box) throw new Error('no /MediaBox in the generated PDF')
  return {
    width: (Number(box[3]) - Number(box[1])) * MM_PER_PT,
    height: (Number(box[4]) - Number(box[2])) * MM_PER_PT,
  }
}
