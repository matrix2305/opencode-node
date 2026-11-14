export interface HubInfo {
  version: string
  hostname?: string
  [key: string]: unknown
}

export class HubError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export class Hub {
  private readonly base: string
  private readonly headers: Record<string, string>

  constructor(url: string, password: string) {
    this.base = url.replace(/\/$/, "")
    this.headers = {
      Authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
    }
  }

  url(pathname: string, query?: Record<string, string>): URL {
    const url = new URL(pathname, this.base)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    return url
  }

  async json<T = any>(pathname: string, query?: Record<string, string>, timeoutMs = 15000): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.url(pathname, query), { headers: this.headers, signal: controller.signal })
      if (!res.ok) throw new HubError(`${pathname} -> ${res.status}`, res.status)
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async text(pathname: string, timeoutMs = 15000): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.url(pathname), { headers: this.headers, signal: controller.signal })
      if (!res.ok) throw new HubError(`${pathname} -> ${res.status}`, res.status)
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }

  info(): Promise<HubInfo> {
    return this.json<HubInfo>("/api/info")
  }

  list(absPath: string): Promise<Array<{ path: string; type: "file" | "directory" }>> {
    return this.json("/api/fs/list", { path: absPath }).then((d) => d.data ?? [])
  }

  read(rel: string): Promise<string> {
    const url = this.url("/api/fs/read/" + rel.split("/").map(encodeURIComponent).join("/"), undefined)
    return this.textUrl(url)
  }

  async textUrl(url: URL, timeoutMs = 15000): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { headers: this.headers, signal: controller.signal })
      if (!res.ok) throw new HubError(`${url.pathname} -> ${res.status}`, res.status)
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }

  async write(absPath: string, content: string): Promise<void> {
    const url = this.url("/api/experimental/fs/write", { path: absPath })
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/octet-stream" },
      body: content,
    })
    if (!res.ok) throw new HubError(`write ${absPath} -> ${res.status}`, res.status)
  }
}
