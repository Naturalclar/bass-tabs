import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromAsciiTab, isAsciiTab } from '../src/editor/asciiTab.ts'
import { importFile } from '../src/editor/importFile.ts'
import { type Entry } from '../src/editor/model.ts'
import { isScore } from '../src/editor/storage.ts'
import { asciiFixtureDir, openEditor } from './helpers.ts'

/**
 * ASCII タブの取り込み。持っているのは弦・フレット・小節線だけで音価が無いので、
 * ここで検査するのは「並びと小節は元のとおり、音価は推定せず一様、持てない
 * 記法は理由つきで断る」こと。パーサーは純関数なのでブラウザ抜きで直接見る。
 */
test.describe('ASCII タブの取り込み', () => {
  const note = (fingerings: { string: number; fret: number }[], value: 8 | 16 = 8): Entry => ({
    kind: 'note',
    notes: fingerings,
    value,
    dotted: false,
    triplet: false,
  })
  const rest = (value: 1 | 2 | 4 | 8 | 16): Entry => ({
    kind: 'rest',
    value,
    dotted: false,
    triplet: false,
  })
  const one = (string: number, fret: number, value: 8 | 16 = 8) => note([{ string, fret }], value)

  const ISSUE_EXAMPLE = [
    'G|-----------------|-----------------|',
    'D|-----------0-----|-----------------|',
    'A|-----0--2-----2--|--0--2--3--2--0--|',
    'E|--0--------------|-----------------|',
  ].join('\n')

  test('issue の例: 小節ごとに、並びのまま全部 8 分で入る', () => {
    const result = fromAsciiTab(ISSUE_EXAMPLE, '例')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dense).toBe(false)
    expect(result.score.tuning).toBe('four')
    expect(result.score.title).toBe('例')
    expect(result.score.measures).toEqual([
      // 5 音 = 60 tick、残り 36 は 4 分 + 8 分の休符
      [one(4, 0), one(3, 0), one(3, 2), one(2, 0), one(3, 2), rest(4), rest(8)],
      [one(3, 0), one(3, 2), one(3, 3), one(3, 2), one(3, 0), rest(4), rest(8)],
    ])
    expect(isScore(result.score)).toBe(true)
  })

  test('同じ桁の数字は和音。右寄せの 1 桁も 2 桁の下なら同じ拍', () => {
    const text = ['G|--12--|', 'D|--10--|', 'A|---9--|', 'E|------|'].join('\n')
    const result = fromAsciiTab(text, 'x')
    expect(result.ok && result.score.measures[0][0]).toEqual(
      note([
        { string: 1, fret: 12 },
        { string: 2, fret: 10 },
        { string: 3, fret: 9 },
      ]),
    )
  })

  test('9 音以上の小節は 16 分、17 音以上は断る', () => {
    // 続いた数字は 1 つの数（"12"）なので、音の間にはダッシュが要る
    const bar = '0-1-2-3-4-5-6-7-8-9-8-7-'
    const twelve = [`G|${'-'.repeat(24)}|`, `D|${'-'.repeat(24)}|`, `A|${'-'.repeat(24)}|`, `E|${bar}|`]
    const result = fromAsciiTab(twelve.join('\n'), 'x')
    expect(result.ok && result.dense).toBe(true)
    expect(result.ok && result.score.measures[0].slice(0, 2)).toEqual([one(4, 0, 16), one(4, 1, 16)])
    // 12 × 6 = 72、残り 24 は 4 分休符
    expect(result.ok && result.score.measures[0].at(-1)).toEqual(rest(4))

    const many = '0-'.repeat(17)
    const seventeen = [`G|${'-'.repeat(34)}|`, `D|${'-'.repeat(34)}|`, `A|${'-'.repeat(34)}|`, `E|${many}|`]
    expect(fromAsciiTab(seventeen.join('\n'), 'x')).toEqual({ ok: false, reason: 'too-dense' })
  })

  test('縦に積んだブロックは左から右、次のブロックへと繋がる', () => {
    const text = [
      'Verse',
      'G|--0--|--1--|',
      'D|-----|-----|',
      'A|-----|-----|',
      'E|-----|-----|',
      '',
      'Chorus',
      'G|--2--|',
      'D|-----|',
      'A|-----|',
      'E|-----|',
    ].join('\n')
    const result = fromAsciiTab(text, 'x')
    expect(result.ok && result.score.measures.map((m) => m[0])).toEqual([one(1, 0), one(1, 1), one(1, 2)])
  })

  test('B 弦の行があれば 5 弦。ラベル無し・小文字・ドロップ D', () => {
    const five = ['G|--0--|', 'D|-----|', 'A|-----|', 'E|-----|', 'B|--3--|'].join('\n')
    const result = fromAsciiTab(five, 'x')
    expect(result.ok && result.score.tuning).toBe('five')
    expect(result.ok && result.score.measures[0][0]).toEqual(
      note([
        { string: 1, fret: 0 },
        { string: 5, fret: 3 },
      ]),
    )

    const unlabelled = ['|--0--|', '|-----|', '|-----|', '|--3--|'].join('\n')
    expect(fromAsciiTab(unlabelled, 'x')).toMatchObject({ ok: true, score: { tuning: 'four' } })

    const lower = ['g|--0--|', 'd|-----|', 'a|-----|', 'e|-----|'].join('\n')
    expect(fromAsciiTab(lower, 'x')).toMatchObject({ ok: true, score: { tuning: 'four' } })

    // 一番下が D はドロップ D。モデルに無いチューニングなので断る
    const drop = ['G|--0--|', 'D|-----|', 'A|-----|', 'D|-----|'].join('\n')
    expect(fromAsciiTab(drop, 'x')).toEqual({ ok: false, reason: 'unsupported' })
    // 6 弦
    const six = ['e|--0--|', 'B|-----|', 'G|-----|', 'D|-----|', 'A|-----|', 'E|-----|'].join('\n')
    expect(fromAsciiTab(six, 'x')).toEqual({ ok: false, reason: 'unsupported' })
  })

  test('奏法記号・24 を超える数字は黙って落とさず断る', () => {
    const hammer = ['G|-------|', 'D|-------|', 'A|--5h7--|', 'E|-------|'].join('\n')
    expect(fromAsciiTab(hammer, 'x')).toEqual({ ok: false, reason: 'unsupported' })
    const slide = ['G|-------|', 'D|-------|', 'A|--5/7--|', 'E|-------|'].join('\n')
    expect(fromAsciiTab(slide, 'x')).toEqual({ ok: false, reason: 'unsupported' })
    const mute = ['G|-----|', 'D|-----|', 'A|--x--|', 'E|-----|'].join('\n')
    expect(fromAsciiTab(mute, 'x')).toEqual({ ok: false, reason: 'unsupported' })
    const high = ['G|------|', 'D|------|', 'A|--25--|', 'E|------|'].join('\n')
    expect(fromAsciiTab(high, 'x')).toEqual({ ok: false, reason: 'unsupported' })
  })

  test('小節線の数が弦ごとに違えば断る。タブの行が無い・音が無いも別の理由', () => {
    const skewed = ['G|--0--|-----|', 'D|-----|', 'A|-----|', 'E|-----|'].join('\n')
    expect(fromAsciiTab(skewed, 'x')).toEqual({ ok: false, reason: 'misaligned' })
    expect(fromAsciiTab('ただの文章です。\nタブではない。', 'x')).toEqual({ ok: false, reason: 'no-tab' })
    expect(isAsciiTab('ただの文章です。')).toBe(false)
    expect(isAsciiTab(ISSUE_EXAMPLE)).toBe(true)
    const empty = ['G|-----|', 'D|-----|', 'A|-----|', 'E|-----|'].join('\n')
    expect(fromAsciiTab(empty, 'x')).toEqual({ ok: false, reason: 'no-notes' })
  })

  test('65 小節は断る', () => {
    const bars = Array.from({ length: 65 }, () => '--0--').join('|')
    const text = ['G|' + bars + '|', 'D|' + bars + '|', 'A|' + bars + '|', 'E|' + bars + '|'].join('\n')
    expect(fromAsciiTab(text, 'x')).toEqual({ ok: false, reason: 'too-long' })
  })

  test('importFile は .txt / .tab を ASCII タブとして振り分ける', async () => {
    const ok = await importFile(new File([ISSUE_EXAMPLE], 'riff.txt', { type: 'text/plain' }))
    expect(ok.scores).toHaveLength(1)
    expect(ok.scores[0].title).toBe('riff')
    expect(ok.notice).toContain('全部 8 分音符')

    const refused = await importFile(new File(['G|--5h7--|\nD|-------|\nA|-------|\nE|-------|'], 'x.tab'))
    expect(refused.scores).toHaveLength(0)
    expect(refused.notice).toContain('奏法記号')
  })
})

test('ASCII タブの .txt を一覧に取り込める', async ({ page }) => {
  await openEditor(page)
  const path = join(asciiFixtureDir(), 'riff.txt')
  writeFileSync(path, 'G|-----------------|\nD|-----------0-----|\nA|-----0--2-----2--|\nE|--0--------------|\n')
  await page.setInputFiles('.sidebar input[type="file"]', path)
  await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
  await expect(page.locator('.score-row')).toHaveCount(2)
  await expect(page.getByLabel('曲名')).toHaveValue('riff')
  await expect(page.locator('.tab-cell--note')).toHaveText(['0', '0', '2', '0', '2'])
})

test('エディタにタブ譜を貼り付けると新しい譜面になる', async ({ page }) => {
  await openEditor(page)
  const paste = (text: string) =>
    page.evaluate((text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    }, text)

  // ただの文章は何も起こさない
  await paste('こんにちは')
  await expect(page.locator('.score-row')).toHaveCount(1)
  await expect(page.locator('.sidebar__notice')).toHaveCount(0)

  await paste('G|-----|\nD|-----|\nA|--3--|\nE|--0--|\n')
  await expect(page.locator('.score-row')).toHaveCount(2)
  await expect(page.locator('.sidebar__notice')).toContainText('1 曲を取り込みました')
  await expect(page.locator('.tab-cell--note')).toHaveText(['3', '0'])

  // 曲名欄への貼り付けは曲名欄のもの
  await page.getByLabel('曲名').focus()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'G|--0--|\nD|-----|\nA|-----|\nE|-----|')
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await expect(page.locator('.score-row')).toHaveCount(2)
})
