import { fromBackup } from './backup.ts'
import { fromTabImage } from './imageImport.ts'
import { fromMusicXml } from './musicxmlImport.ts'
import { MAX_MEASURES } from './model.ts'
import type { Score } from './model.ts'

/** What one imported file becomes: scores to add (possibly none) and what to tell. */
export type ImportOutcome = { scores: Score[]; notice: string }

/** Files read by pixel analysis + OCR rather than as text. */
export function isTabImage(name: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(name)
}

/**
 * Takes a whole library (.json), a single MusicXML score, or a screenshot of
 * a tab. All are read the same way -- validate, then add -- so an unreadable
 * file changes nothing and says why instead of failing quietly. This function
 * never throws: whatever goes wrong becomes the notice, because a rejected
 * promise would leave the person with no file imported and nothing said
 * about it.
 *
 * The mapping from each reader's refusal to its notice lives here, next to
 * the dispatch, so it can be checked directly -- the UI's only job is to
 * show `notice` and add `scores`.
 */
export async function importFile(file: File): Promise<ImportOutcome> {
  try {
    return await read(file)
  } catch (error: unknown) {
    return {
      scores: [],
      notice: `ファイルを読めませんでした: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function read(file: File): Promise<ImportOutcome> {
  if (isTabImage(file.name)) {
    // Imported statically, on purpose. This was a dynamic import for a while,
    // meant to keep the recogniser out of the first load -- but video mode
    // needs the same module and is reachable from the toolbar, so it landed
    // in the main chunk anyway and rolldown said so on every build. Measured,
    // splitting both entry points apart moves 7 KB (3.5 KB gzipped) out of a
    // 1,550 KB chunk that is almost entirely OSMD: not worth two indirections
    // and a comment in each explaining why they must stay dynamic.
    //
    // The megabytes *are* still deferred: tesseract.js and its wasm are
    // loaded on demand inside `imageImport.ts` itself, and nothing here
    // pulls them in.
    const result = await fromTabImage(file, file.name.replace(/\.[^.]+$/, ''))
    if (!result.ok) {
      return {
        scores: [],
        notice:
          result.reason === 'no-lanes'
            ? '4 本の弦の線が見つかりませんでした'
            : result.reason === 'no-notes'
              ? '弦の線の上に数字が見つかりませんでした'
              : result.reason === 'too-long'
                ? `小節が多すぎて取り込めません（上限 ${MAX_MEASURES} 小節）`
                : '画像を読めませんでした',
      }
    }
    return {
      scores: [result.score],
      notice:
        result.unread > 0
          ? `1 曲を取り込みました（${result.unread} 箇所読めず、休符にしてあります）`
          : '1 曲を取り込みました（全部 8 分音符なので、音価はエディタで直してください）',
    }
  }

  const text = await file.text()
  if (file.name.endsWith('.json')) {
    const result = fromBackup(text)
    if (!result.ok) {
      return {
        scores: [],
        notice:
          result.reason === 'wrong-format'
            ? 'この JSON は bass-tabs の書き出しではありません'
            : result.reason === 'wrong-version'
              ? '対応していない版の書き出しです'
              : result.reason === 'no-scores'
                ? '読める譜面がありませんでした'
                : 'ファイルを読めませんでした',
      }
    }
    return { scores: result.scores, notice: `${result.scores.length} 曲を取り込みました` }
  }

  const result = fromMusicXml(text)
  if (!result.ok) {
    return {
      scores: [],
      notice:
        result.reason === 'no-tab'
          ? 'TAB 譜が入っていないので取り込めません（表示は「ファイルを開く」から）'
          : result.reason === 'unsupported'
            ? 'タイ・装飾音が入っているので取り込めません（表示は「ファイルを開く」から）'
            : result.reason === 'too-long'
              ? `小節が多すぎて取り込めません（上限 ${MAX_MEASURES} 小節）`
              : result.reason === 'overfull'
                ? '拍子に収まらない小節があるので取り込めません'
                : 'ファイルを読めませんでした',
    }
  }
  return { scores: [result.score], notice: '1 曲を取り込みました' }
}
