/** The v= / youtu.be / shorts forms of a YouTube link, to one video id. */
export function videoIdOf(link: string): string | null {
  const valid = (id: string | null) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null)
  try {
    const url = new URL(link.trim())
    if (url.hostname === 'youtu.be') return valid(url.pathname.slice(1).split('/')[0])
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)) {
      if (url.pathname === '/watch') return valid(url.searchParams.get('v'))
      const path = url.pathname.match(/^\/(embed|shorts|live)\/([^/]+)/)
      if (path) return valid(path[2])
    }
  } catch {
    // Not a URL at all; fall through.
  }
  return null
}
