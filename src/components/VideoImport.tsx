import { useCallback, useEffect, useRef, useState } from 'react'
import { readTabEntries } from '../editor/imageImport.ts'
import { analyzeTabImage } from '../editor/tabImage.ts'
import {
  beatsOf,
  isWhole,
  sameScreen,
  scrolledBeats,
  signatureOf,
  type ScreenBeat,
  type ScreenSignature,
} from '../editor/videoScan.ts'
import { estimateGrid, onsetTimes } from '../editor/audio.ts'
import { decodeMonoSamples } from '../editor/audioImport.ts'
import { noteDurations } from '../editor/quantize.ts'
import type { Entry, TimeSignature } from '../editor/model.ts'
import { videoIdOf } from '../editor/videoLink.ts'

type Props = {
  /** Appends recognised entries to the open score; returns what actually fit. */
  onAppend: (entries: Entry[]) => { added: number; dropped: number }
  /** The open score's meter -- the quantiser needs it for the barline check. */
  time: TimeSignature
}

/**
 * Video mode, two ways in:
 *
 * A YouTube link plays in an embed whose pixels are cross-origin, so screen
 * capture is the only way to see them -- the person shares this tab and reads
 * one screenful at a time. That cannot be automatic: sharing needs a person
 * to grant it, and the song plays in real time.
 *
 * A video *file* has neither limit. Its frames are same-origin, so 走査 can
 * seek through the whole thing at decode speed, spot each new screenful of
 * tab (videoScan.ts) and read it once, no sharing involved.
 *
 * Each capture -- and each screen the scan appends -- is one commit in the
 * editor, so one Ctrl+Z takes back one of them.
 */

function frameOf(
  video: HTMLVideoElement,
  region?: { x: number; y: number; w: number; h: number },
): ImageData {
  const area = region ?? { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight }
  const canvas = document.createElement('canvas')
  canvas.width = area.w
  canvas.height = area.h
  const context = canvas.getContext('2d') as CanvasRenderingContext2D
  context.drawImage(video, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h)
  return context.getImageData(0, 0, area.w, area.h)
}

/**
 * The file's audio track as mono PCM. The `<video>` is muted, but that is
 * about playback -- the track is in the file, and this is what #75 reads the
 * rhythm from. Null when the file has no audio or cannot be decoded; the
 * scan then keeps its all-eighths behaviour.
 */
async function monoSamples(
  url: string,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  try {
    return await decodeMonoSamples(await (await fetch(url)).arrayBuffer())
  } catch {
    return null
  }
}

/** Resolves once the video sits on the requested time. */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    // Guarded: seeking to the current position fires no event in some
    // browsers, and a scan that hangs on a silent seek helps nobody.
    const guard = setTimeout(() => done(), 1000)
    const done = () => {
      clearTimeout(guard)
      video.removeEventListener('seeked', done)
      resolve()
    }
    video.addEventListener('seeked', done)
    video.currentTime = time
  })
}

/**
 * A recorded webm (and some streams) reports Infinity until it is forced to
 * work its length out; seeking far past the end is the established way to
 * force it. Files with sane metadata skip this entirely.
 */
async function resolvedDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration)) return video.duration
  await seekTo(video, Number.MAX_SAFE_INTEGER)
  await seekTo(video, 0)
  return video.duration
}

export function VideoImport({ onAppend, time }: Props) {
  const [link, setLink] = useState('')
  const [videoId, setVideoId] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [notice, setNotice] = useState(
    '動画ファイルを開くか、リンクを貼ってこのタブを画面共有すると、映っているタブ譜を読み取れます',
  )
  const streamRef = useRef<MediaStream | null>(null)
  // The scan loop runs across many commits, and each commit hands the editor
  // a new appendEntries. A loop that captured the prop once would append
  // every screen onto the score as it was when the scan started -- the last
  // screen wins and the rest silently vanish. Read through a ref instead.
  const onAppendRef = useRef(onAppend)
  useEffect(() => {
    onAppendRef.current = onAppend
  }, [onAppend])
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileVideoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<HTMLIFrameElement>(null)
  const abortScan = useRef(false)

  const stopSharing = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setSharing(false)
  }, [])

  // Leaving video mode must end the capture and the scan: nobody expects a
  // page they navigated away from to keep watching their screen or spinning.
  useEffect(() => {
    return () => {
      stopSharing()
      abortScan.current = true
    }
  }, [stopSharing])
  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl)
    }
  }, [fileUrl])

  const handleLink = useCallback((value: string) => {
    setLink(value)
    if (value.trim() === '') {
      setVideoId(null)
      return
    }
    const id = videoIdOf(value)
    setVideoId(id)
    setNotice(id ? '動画を再生し、タブ譜が映ったら読み取ってください' : 'YouTube のリンクとして読めません')
  }, [])

  const handleFile = useCallback((file: File) => {
    setFileUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return URL.createObjectURL(file)
    })
    setNotice(
      '「動画を走査して全部読み取る」で頭から終わりまで読みます。場面を選んで「今の画面を読み取る」もできます',
    )
  }, [])

  const handleShare = useCallback(async () => {
    try {
      // preferCurrentTab is Chromium-only; elsewhere the picker just opens
      // without a preselection, which is fine.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        // eslint-disable-next-line
        ...({ preferCurrentTab: true } as object),
      })
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play()
      }
      stream.getVideoTracks()[0]?.addEventListener('ended', stopSharing)
      setSharing(true)
      setNotice('共有中。タブ譜が映っている状態で「今の画面を読み取る」を押してください')
    } catch {
      setNotice('画面共有を開始できませんでした（ブラウザが対応していないか、拒否されました）')
    }
  }, [stopSharing])

  const appendResult = useCallback(
    (result: { entries: Entry[]; unread: number }) => {
      const { added, dropped } = onAppendRef.current(result.entries)
      const parts = [`${added} 音を譜面の末尾に足しました`]
      if (result.unread > 0) parts.push(`${result.unread} 箇所は読めず休符`)
      if (dropped > 0) parts.push(`${dropped} 音は 64 小節の上限で入りませんでした`)
      return parts
    },
    [],
  )

  const handleCapture = useCallback(async () => {
    // A loaded file is the better source when both are around: its frames
    // are the video alone, no page around them.
    const fromFile = fileUrl !== null
    const video = fromFile ? fileVideoRef.current : videoRef.current
    if (!video || video.videoWidth === 0) {
      setNotice('まだ映像が届いていません。少し待ってからもう一度押してください')
      return
    }
    setBusy(true)
    setNotice('読み取っています…')
    try {
      // When the person shared this tab, the frame is this page's viewport,
      // and the player's own rectangle is knowable -- reading just that keeps
      // the page around the video (its text, its blocks of colour) out of the
      // analysis. The scale check is what tells "shared this tab" apart from
      // "shared a window or screen", where the rectangle would land on the
      // wrong pixels; and if the crop finds no staff, the full frame gets its
      // turn, so a wrong guess costs a retry, not the capture.
      let cropped: { x: number; y: number; w: number; h: number } | undefined
      const rect = playerRef.current?.getBoundingClientRect()
      const page = document.documentElement
      if (!fromFile && rect && rect.width > 0) {
        const scaleX = video.videoWidth / page.clientWidth
        const scaleY = video.videoHeight / page.clientHeight
        if (Math.abs(scaleX / scaleY - 1) < 0.1 && scaleX > 0.5 && scaleX < 4) {
          const x = Math.max(0, Math.floor(rect.left * scaleX))
          const y = Math.max(0, Math.floor(rect.top * scaleY))
          const w = Math.min(video.videoWidth - x, Math.ceil(rect.width * scaleX))
          const h = Math.min(video.videoHeight - y, Math.ceil(rect.height * scaleY))
          if (w > 50 && h > 50) cropped = { x, y, w, h }
        }
      }

      let result = await readTabEntries(frameOf(video, cropped))
      if (!result.ok && result.reason === 'no-lanes' && cropped) {
        result = await readTabEntries(frameOf(video))
      }
      if (!result.ok) {
        setNotice(
          result.reason === 'no-lanes'
            ? '4 本の弦の線が見つかりませんでした（タブ譜が画面に映っているか確認してください）'
            : '弦の線の上に数字が見つかりませんでした',
        )
        return
      }
      setNotice(`${appendResult(result).join('。')}（取り消しは Ctrl+Z）`)
    } finally {
      setBusy(false)
    }
  }, [appendResult, fileUrl])

  /**
   * Seeks through the whole file at a fixed step, reading each new screenful
   * of tab exactly once. A screen is read on its *second* consecutive
   * sighting: one frame alone can be mid-transition, and reading garbage
   * once would append garbage once.
   *
   * #75: the file's audio decides the note values, where it can. One grid
   * for the whole file, decoded up front; per screen, the onsets inside its
   * display window stand in for its notes -- but only when the counts agree
   * and every glyph was read (an unread rest has no onset to pair with).
   * Anything else keeps the all-eighths import, the honest fallback. A
   * screen's window only closes when the next screen appears, so a read
   * screen is held back one step and appended then -- still one commit per
   * screen, and never two commits in the same tick (the second would read
   * the score as it was before the first; the onAppendRef comment above is
   * about exactly this).
   */
  const handleScan = useCallback(async () => {
    const video = fileVideoRef.current
    if (!video || video.readyState === 0) {
      setNotice('動画がまだ読み込まれていません')
      return
    }
    setScanning(true)
    abortScan.current = false
    const STEP = 0.5
    let lastAppended: ScreenSignature | null = null
    // The beats of the last appended screen, for a tab that scrolls instead
    // of switching: each frame is matched against these by shift, and only
    // what came into view since is read. Kept in the coordinates of the
    // frame it was last seen in.
    let frontier: ScreenBeat[] | null = null
    let pending: ScreenSignature | null = null
    let pendingBeats: ScreenBeat[] = []
    let pendingFrame: ImageData | null = null
    let pendingSeenAt = 0
    let held: { entries: Entry[]; unread: number; seenAt: number } | null = null
    let screens = 0
    let notes = 0
    let unread = 0
    let timed = 0
    let scrolled = 0
    try {
      video.pause()
      const duration = await resolvedDuration(video)
      if (!Number.isFinite(duration) || duration <= 0) {
        setNotice('この動画の長さが分からず、走査できませんでした')
        return
      }

      const audio = await monoSamples(fileUrl ?? video.src)
      const onsets = audio ? onsetTimes(audio.samples, audio.sampleRate) : []
      const grid = estimateGrid(onsets)

      const flush = (windowEnd: number) => {
        if (!held) return
        const screen = held
        held = null
        let entries = screen.entries
        if (grid && screen.unread === 0 && entries.every((entry) => entry.kind === 'note')) {
          const inWindow = onsets.filter((t) => t >= screen.seenAt && t <= windowEnd)
          const durations =
            inWindow.length === entries.length ? noteDurations(inWindow, grid, time) : null
          if (durations) {
            entries = entries.map((entry, index) => ({ ...entry, ...durations[index] }))
            timed++
          }
        }
        const { added } = onAppendRef.current(entries)
        screens++
        notes += added
        unread += screen.unread
      }

      for (let at = 0; at < duration && !abortScan.current; at += STEP) {
        await seekTo(video, Math.min(at, duration - 0.01))
        setNotice(
          `走査中… ${at.toFixed(1)} / ${duration.toFixed(1)} 秒（${screens} 画面 ${notes} 音）`,
        )
        const frame = frameOf(video)
        const analysis = analyzeTabImage(frame)
        if (!analysis.ok) {
          pending = null
          continue
        }
        const signature = signatureOf(analysis)
        if (lastAppended && sameScreen(signature, lastAppended)) {
          pending = null
          continue
        }
        // A scrolling tab: the appended beats are still there, shifted left,
        // with new ones at the right edge. Those are read and appended on
        // their own -- no waiting to see the frame twice, since the shift
        // match already says this is the same line and not a cut -- and
        // the frontier moves with the frame. Their rhythm is not estimated:
        // a beat read on its own has no display window to count onsets in.
        const beats = beatsOf(analysis)
        // A scrolling tab: the appended beats are still there, shifted left,
        // with new ones at the right edge. Those are read and appended on
        // their own -- no waiting to see the frame twice, since the shift
        // match already says this is the same line and not a cut -- and
        // the frontier moves with the frame. Their rhythm is not estimated:
        // a beat read on its own has no display window to count onsets in.
        const takeScrolled = async (scroll: NonNullable<ReturnType<typeof scrolledBeats>>) => {
          if (scroll.fresh.length > 0) {
            const result = await readTabEntries(frame, scroll.fresh)
            if (result.ok && result.entries.length > 0) {
              flush(at)
              const { added } = onAppendRef.current(result.entries)
              notes += added
              unread += result.unread
              scrolled += result.entries.length
            }
          }
          const appended = new Set(scroll.fresh)
          frontier = beats.filter((_, index) => scroll.matched[index] || appended.has(index))
          lastAppended = null
          pending = null
        }
        const scroll = frontier ? scrolledBeats(frontier, beats) : null
        if (scroll) {
          await takeScrolled(scroll)
          continue
        }
        if (pending && sameScreen(signature, pending)) {
          const result = await readTabEntries(frame)
          if (result.ok && result.entries.length > 0) {
            flush(pendingSeenAt)
            held = { entries: result.entries, unread: result.unread, seenAt: pendingSeenAt }
          }
          lastAppended = signature
          frontier = beats
          pending = null
          continue
        }
        const moved = pending && pendingFrame ? scrolledBeats(pendingBeats, beats) : null
        if (moved && moved.shift > 0 && pendingFrame) {
          // Not the same screen twice, but the same line moved on: a
          // scrolling tab, seen for the first time. The frame it was first
          // seen in is the start of the line -- read from *that* frame,
          // since its leftmost beat may already have left this one -- and
          // from here the frontier takes over.
          const whole = pendingBeats
            .map((_, index) => index)
            .filter((index) => isWhole(pendingBeats[index]))
          const result = whole.length > 0 ? await readTabEntries(pendingFrame, whole) : null
          if (result?.ok && result.entries.length > 0) {
            flush(pendingSeenAt)
            const { added } = onAppendRef.current(result.entries)
            screens++
            notes += added
            unread += result.unread
          }
          frontier = whole.map((index) => pendingBeats[index])
          const rest = scrolledBeats(frontier, beats)
          if (rest) await takeScrolled(rest)
          lastAppended = null
          pending = null
          continue
        }
        pending = signature
        pendingBeats = beats
        pendingFrame = frame
        pendingSeenAt = at
      }
      flush(duration)

      const parts =
        screens > 0
          ? [
              scrolled > 0
                ? `${screens} 画面と、流れてきた ${scrolled} 拍から ${notes} 音を取り込みました`
                : `${screens} 画面から ${notes} 音を取り込みました`,
            ]
          : ['タブ譜の画面が見つかりませんでした']
      if (unread > 0) parts.push(`${unread} 箇所は読めず休符`)
      if (abortScan.current) parts.push('途中で停止しました')
      if (timed === screens && timed > 0) {
        parts.push('音の長さは音声から推定しました。外れていたらエディタで直してください')
      } else if (timed > 0) {
        parts.push(`音の長さは ${timed} 画面ぶんだけ音声から推定しました。残りはエディタで直してください`)
      } else if (screens > 0) {
        parts.push('音価はエディタで直してください')
      }
      setNotice(parts.join('。'))
    } finally {
      setScanning(false)
    }
  }, [fileUrl, time])

  return (
    <section className="video-import">
      <div className="editor-row">
        <label className="button">
          動画ファイルを開く
          <input
            className="visually-hidden"
            type="file"
            accept="video/*"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) handleFile(file)
              event.target.value = ''
            }}
          />
        </label>
        <button
          type="button"
          className="button"
          onClick={() => {
            if (scanning) abortScan.current = true
            else void handleScan()
          }}
          disabled={!fileUrl || busy}
        >
          {scanning ? '走査を停止' : '動画を走査して全部読み取る'}
        </button>
        <button
          type="button"
          className="button"
          onClick={handleCapture}
          disabled={(!sharing && !fileUrl) || busy || scanning}
        >
          今の画面を読み取る
        </button>
      </div>
      <div className="editor-row">
        <label className="editor-field video-import__link">
          YouTube のリンク
          <input
            value={link}
            onChange={(event) => handleLink(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
          />
        </label>
        {!sharing ? (
          <button type="button" className="button" onClick={handleShare}>
            画面共有を開始
          </button>
        ) : (
          <button type="button" className="button" onClick={stopSharing}>
            共有を停止
          </button>
        )}
      </div>
      <p className="video-import__notice" role="status">
        {notice}
      </p>
      {fileUrl && (
        <video
          ref={fileVideoRef}
          className="video-import__player"
          src={fileUrl}
          controls
          muted
          playsInline
        />
      )}
      {videoId && !fileUrl && (
        <iframe
          ref={playerRef}
          className="video-import__player"
          src={`https://www.youtube-nocookie.com/embed/${videoId}`}
          title="YouTube"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      )}
      {/* Decodes the captured stream; the frames are read from here. Hidden
          because showing the tab inside the tab would hall-of-mirror. */}
      <video ref={videoRef} className="visually-hidden" muted playsInline />
    </section>
  )
}
