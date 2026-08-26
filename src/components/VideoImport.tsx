import { useCallback, useEffect, useRef, useState } from 'react'
import { readTabEntries } from '../editor/imageImport.ts'
import type { Entry } from '../editor/model.ts'
import { videoIdOf } from '../editor/videoLink.ts'

type Props = {
  /** Appends recognised entries to the open score; returns what actually fit. */
  onAppend: (entries: Entry[]) => { added: number; dropped: number }
}

/**
 * Video mode: paste a YouTube link, share this tab, and read the overlay tab
 * one screenful at a time. The embed's pixels are cross-origin, so screen
 * capture is the only way to see them from here -- which is also why this
 * cannot be automatic: sharing needs a person to grant it.
 *
 * Each 読み取る press is one commit in the editor, so one Ctrl+Z takes back
 * one capture.
 */

export function VideoImport({ onAppend }: Props) {
  const [link, setLink] = useState('')
  const [videoId, setVideoId] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(
    'リンクを貼って動画を出し、このタブを画面共有すると、映っているタブ譜を読み取れます',
  )
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<HTMLIFrameElement>(null)

  const stopSharing = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setSharing(false)
  }, [])

  // Leaving video mode must end the capture: nobody expects a page they
  // navigated away from to keep watching their screen.
  useEffect(() => stopSharing, [stopSharing])

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

  const handleCapture = useCallback(async () => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) {
      setNotice('まだ映像が届いていません。少し待ってからもう一度押してください')
      return
    }
    setBusy(true)
    setNotice('読み取っています…')
    try {
      const frameOf = (region?: { x: number; y: number; w: number; h: number }) => {
        const area = region ?? { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight }
        const canvas = document.createElement('canvas')
        canvas.width = area.w
        canvas.height = area.h
        const context = canvas.getContext('2d') as CanvasRenderingContext2D
        context.drawImage(video, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h)
        return context.getImageData(0, 0, area.w, area.h)
      }

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
      if (rect && rect.width > 0) {
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

      let result = await readTabEntries(frameOf(cropped))
      if (!result.ok && result.reason === 'no-lanes' && cropped) {
        result = await readTabEntries(frameOf())
      }
      if (!result.ok) {
        setNotice(
          result.reason === 'no-lanes'
            ? '4 本の弦の線が見つかりませんでした（タブ譜が画面に映っているか確認してください）'
            : '弦の線の上に数字が見つかりませんでした',
        )
        return
      }
      const { added, dropped } = onAppend(result.entries)
      const parts = [`${added} 音を譜面の末尾に足しました`]
      if (result.unread > 0) parts.push(`${result.unread} 箇所は読めず休符`)
      if (dropped > 0) parts.push(`${dropped} 音は 64 小節の上限で入りませんでした`)
      setNotice(`${parts.join('。')}（取り消しは Ctrl+Z）`)
    } finally {
      setBusy(false)
    }
  }, [onAppend])

  return (
    <section className="video-import">
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
        <button
          type="button"
          className="button"
          onClick={handleCapture}
          disabled={!sharing || busy}
        >
          今の画面を読み取る
        </button>
      </div>
      <p className="video-import__notice" role="status">
        {notice}
      </p>
      {videoId && (
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
