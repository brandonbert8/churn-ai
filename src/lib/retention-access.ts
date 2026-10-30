const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Local laptop app: no login, and no remote access. */
export function accessAllowed(request: Request) {
  try {
    const url = new URL(request.url)
    if (!loopbackHosts.has(url.hostname)) return false
    const host = request.headers.get('host')
    const publicUrl = host ? new URL(url.protocol + '//' + host) : url
    if (!loopbackHosts.has(publicUrl.hostname)) return false
    const origin = request.headers.get('origin')
    if (origin && new URL(origin).origin !== publicUrl.origin) return false
    return true
  } catch { return false }
}
