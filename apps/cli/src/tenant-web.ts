/**
 * Multi-tenant Web launcher: a selector gateway routes one browser session to
 * one lazily started `dsh web` child. Each named child receives its own HOME,
 * DSH_HOME, working directory, and directory-picker root; the blank selection
 * retains the launcher's original defaults. Identifier routing is isolation,
 * not authentication: deployments still own the outer access-control layer.
 * @module @deepseek-ai/dsh/tenant-web
 */

import { createHash } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex, Readable } from 'node:stream'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Cookie carrying the selected normalized identifier for this browser session. */
export const TENANT_COOKIE = 'dsh_tenant_v1'
/** Selector and switch route, intentionally outside the proxied Harness namespace. */
export const TENANT_SELECTOR_PATH = '/__dsh_tenant'
const TENANT_SELECT_PATH = `${TENANT_SELECTOR_PATH}/select`
export const TENANT_RESET_PATH = `${TENANT_SELECTOR_PATH}/reset`
export const TENANT_DEFAULT_PATH = `${TENANT_SELECTOR_PATH}/default`
export const TENANT_CURRENT_PATH = `${TENANT_SELECTOR_PATH}/current`
const DEFAULT_COOKIE_VALUE = 'default'
const MAX_IDENTIFIER_CHARACTERS = 64
const MAX_FORM_BYTES = 8 * 1024

/** Parsed launcher settings for {@link runTenantWeb}. */
export interface TenantWebOptions {
  host: '127.0.0.1'
  port: number
  tenantRoot?: string
  maxActiveTenants: number
  idleTimeoutMs: number
  startTimeoutMs: number
  patches: readonly string[]
  entrypoint: string
  execArgv: readonly string[]
}

/** A validated selection: null is the launcher's original/default data root. */
export type TenantIdentifier = string | null

/** Browser-safe current routing state; it never contains paths or credential values. */
export type TenantSelectionState =
  | { readonly selected: false }
  | { readonly selected: true; readonly identifier: TenantIdentifier }

interface TenantLayout {
  readonly key: string
  readonly cwd: string
  readonly dshHome?: string
  readonly home?: string
  readonly patch?: string
}

interface TenantRuntime extends TenantLayout {
  readonly child: TenantChild
  readonly port: number
  active: number
  lastUsedAt: number
}

type TenantChild = ChildProcessByStdio<null, Readable, Readable>

interface TenantLease {
  readonly port: number
  release(): void
}

/** The configured active-child limit has no idle child available for eviction. */
export class TenantCapacityError extends Error {
  constructor(readonly maxActiveTenants: number) {
    super(`tenant web has ${String(maxActiveTenants)} active tenants and none is idle`)
    this.name = 'TenantCapacityError'
  }
}

/** Normalize a submitted identifier, preserving case; blank selects the default data root. */
export function normalizeTenantIdentifier(input: string): TenantIdentifier {
  const normalized = input.normalize('NFKC').trim()
  if (normalized === '') return null
  if (Array.from(normalized).length > MAX_IDENTIFIER_CHARACTERS) {
    throw new Error(`标识符最多 ${String(MAX_IDENTIFIER_CHARACTERS)} 个字符`)
  }
  if (/\p{Cc}/u.test(normalized)) throw new Error('标识符不能包含控制字符')
  return normalized
}

/** Encode one validated identifier as the selector's session cookie value. */
export function encodeTenantCookie(identifier: TenantIdentifier): string {
  return identifier === null ? DEFAULT_COOKIE_VALUE : Buffer.from(identifier, 'utf8').toString('base64url')
}

/** Decode a canonical selector cookie; invalid/forged values return undefined and re-open the selector. */
export function decodeTenantCookie(value: string): TenantIdentifier | undefined {
  if (value === DEFAULT_COOKIE_VALUE) return null
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) return undefined
    const normalized = normalizeTenantIdentifier(decoded)
    return normalized === decoded ? normalized : undefined
  } catch {
    return undefined
  }
}

/** Stable, non-reversible directory key for a normalized identifier. */
export function tenantDirectoryKey(identifier: string): string {
  return createHash('sha256').update(identifier, 'utf8').digest('hex')
}

/** Resolve a named tenant's process roots; the default tenant retains the parent process roots. */
export function resolveTenantLayout(identifier: TenantIdentifier, tenantRoot: string, originalCwd: string): TenantLayout {
  if (identifier === null) return { key: DEFAULT_COOKIE_VALUE, cwd: originalCwd }
  const key = tenantDirectoryKey(identifier)
  const root = join(tenantRoot, 'v1', key)
  const home = join(root, 'home')
  const dshHome = join(root, '.dsh')
  return { key, cwd: home, home, dshHome, patch: join(root, 'tenant.patch.yml') }
}

/** Make Node preload/loader operands independent of a named tenant's private cwd. */
export function portableChildExecArgv(execArgv: readonly string[], originalCwd: string): string[] {
  const portableSpecifier = (specifier: string): string => {
    if (/^(?:data|file|node):/u.test(specifier)) return specifier
    if (isAbsolute(specifier)) return pathToFileURL(specifier).href
    if (specifier.startsWith('.')) return pathToFileURL(resolve(originalCwd, specifier)).href
    return import.meta.resolve(specifier)
  }
  const result: string[] = []
  let expectsModule = false
  for (const argument of execArgv) {
    if (expectsModule) {
      result.push(portableSpecifier(argument))
      expectsModule = false
      continue
    }
    const inline = /^(--(?:experimental-)?loader|--import)=(.+)$/u.exec(argument)
    if (inline?.[1] !== undefined && inline[2] !== undefined) {
      result.push(`${inline[1]}=${portableSpecifier(inline[2])}`)
      continue
    }
    result.push(argument)
    expectsModule = argument === '--import' || argument === '--loader' || argument === '--experimental-loader'
  }
  return result
}

/** Preload that switches to the tenant cwd after source loaders initialize at the installation root. */
export function tenantChdirImport(cwd: string): string {
  return `data:text/javascript,${encodeURIComponent(`process.chdir(${JSON.stringify(cwd)})`)}`
}

/** Escape a dynamic diagnostic inserted into the selector document. */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Complete blocking selector document; it loads no script or external resource. */
export function tenantSelectorHtml(error?: string): string {
  const diagnostic = error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>选择 DeepSeek Harness 使用空间</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #111827; color: #f9fafb; }
    main { width: min(32rem, calc(100vw - 3rem)); padding: 2rem; border: 1px solid #374151; border-radius: 1rem; background: #1f2937; box-shadow: 0 1.5rem 4rem #0008; }
    h1 { margin: 0 0 .75rem; font-size: 1.35rem; }
    p { color: #d1d5db; line-height: 1.6; }
    label { display: grid; gap: .5rem; margin-top: 1.5rem; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; padding: .75rem .9rem; border: 1px solid #4b5563; border-radius: .55rem; background: #111827; color: inherit; font: inherit; }
    button { width: 100%; margin-top: 1rem; padding: .75rem; border: 0; border-radius: .55rem; background: #2563eb; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .hint { margin-bottom: 0; font-size: .9rem; }
    .error { color: #fca5a5; }
  </style>
</head>
<body>
  <main>
    <h1>选择使用空间</h1>
    <p>标识符对应独立的工作区、对话历史、设置和上传目录。标识符区分大小写；留空进入默认空间。</p>
    ${diagnostic}
    <form method="post" action="${TENANT_SELECT_PATH}">
      <label>唯一标识符
        <input name="identifier" maxlength="${String(MAX_IDENTIFIER_CHARACTERS)}" autocomplete="off" autofocus placeholder="留空使用默认空间">
      </label>
      <button type="submit">进入 DeepSeek Harness</button>
    </form>
    <p class="hint">标识符用于数据隔离，不是密码；部署仍需使用独立的访问控制。</p>
  </main>
</body>
</html>`
}

/** One cookie header's selected tenant, or undefined when absent/invalid. */
function requestIdentifier(req: IncomingMessage): TenantIdentifier | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const field of header.split(';')) {
    const at = field.indexOf('=')
    if (at === -1 || field.slice(0, at).trim() !== TENANT_COOKIE) continue
    return decodeTenantCookie(field.slice(at + 1).trim())
  }
  return undefined
}

/** Read the selector's bounded form body. */
async function readIdentifierForm(req: IncomingMessage): Promise<TenantIdentifier> {
  let body = Buffer.alloc(0)
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    if (body.byteLength + bytes.byteLength > MAX_FORM_BYTES) throw new Error('提交内容过大')
    body = Buffer.concat([body, bytes])
  }
  const params = new URLSearchParams(body.toString('utf8'))
  if (!params.has('identifier')) throw new Error('缺少标识符字段')
  return normalizeTenantIdentifier(params.get('identifier') ?? '')
}

/** Write the selector with headers that prevent a shared browser cache from crossing selections. */
function serveSelector(res: ServerResponse, status = 200, error?: string): void {
  const body = tenantSelectorHtml(error)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Write one no-store JSON response owned by the selector gateway. */
function serveJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Selector cookie, session-scoped and HttpOnly; Secure follows the outer TLS hop. */
function selectionCookie(req: IncomingMessage, value: string, maxAge?: number): string {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  const expiry = maxAge === undefined ? '' : `; Max-Age=${String(maxAge)}`
  return `${TENANT_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${secure}${expiry}`
}

/** Headers safe and meaningful on the private loopback hop to a tenant child. */
function childHeaders(req: IncomingMessage, port: number): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...req.headers, host: `127.0.0.1:${String(port)}` }
  delete headers.cookie
  delete headers.origin
  delete headers['sec-fetch-site']
  return headers
}

/** Raw upgrade headers for the private loopback hop. */
function childUpgradeHead(req: IncomingMessage, port: number): string {
  const skipped = new Set(['host', 'cookie', 'origin', 'sec-fetch-site'])
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]
    const value = req.rawHeaders[index + 1]
    if (name === undefined || value === undefined || skipped.has(name.toLowerCase())) continue
    lines.push(`${name}: ${value}`)
  }
  lines.push(`Host: 127.0.0.1:${String(port)}`, '', '')
  return lines.join('\r\n')
}

/** Lazily owns one isolated child per active identifier. */
class TenantManager {
  private readonly runtimes = new Map<string, TenantRuntime>()
  private readonly starting = new Map<string, Promise<TenantRuntime>>()
  private operationTail: Promise<void> = Promise.resolve()
  private readonly originalCwd = process.cwd()
  private readonly tenantRoot: string
  private readonly defaultCredentialsPath: string
  private readonly patches: string[]
  private readonly childExecArgv: string[]
  private readonly sweep: NodeJS.Timeout

  constructor(private readonly options: TenantWebOptions) {
    this.tenantRoot = resolve(options.tenantRoot ?? join(resolveDshHome(), 'tenant-web'))
    this.defaultCredentialsPath = join(resolveDshHome(), '.credentials.yaml')
    this.patches = options.patches.map(path => resolve(path))
    this.childExecArgv = portableChildExecArgv(options.execArgv, this.originalCwd)
    const sweepMs = Math.min(options.idleTimeoutMs, 60_000)
    this.sweep = setInterval(() => { void this.expire() }, sweepMs)
    this.sweep.unref()
  }

  /** Acquire an active request/socket lease, starting the tenant when absent. */
  async acquire(identifier: TenantIdentifier): Promise<TenantLease> {
    const layout = resolveTenantLayout(identifier, this.tenantRoot, this.originalCwd)
    const runtime = await this.runtime(layout)
    runtime.active++
    runtime.lastUsedAt = Date.now()
    let released = false
    return {
      port: runtime.port,
      release: () => {
        if (released) return
        released = true
        runtime.active--
        runtime.lastUsedAt = Date.now()
      },
    }
  }

  /** Stop idle children whose configured lifetime elapsed. */
  async expire(now = Date.now()): Promise<void> {
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.active !== 0 || now - runtime.lastUsedAt < this.options.idleTimeoutMs) continue
      await this.stop(runtime)
    }
  }

  /** Stop accepting tenant work and terminate every owned child. */
  async dispose(): Promise<void> {
    clearInterval(this.sweep)
    await Promise.allSettled([...this.starting.values()])
    await Promise.all([...this.runtimes.values()].map(runtime => this.stop(runtime)))
  }

  /** Serialize cache misses so the active-process limit cannot be raced. */
  private runtime(layout: TenantLayout): Promise<TenantRuntime> {
    const ready = this.runtimes.get(layout.key)
    if (ready !== undefined) return Promise.resolve(ready)
    const pending = this.starting.get(layout.key)
    if (pending !== undefined) return pending
    let settle!: (runtime: TenantRuntime) => void
    let reject!: (error: unknown) => void
    const result = new Promise<TenantRuntime>((resolveRuntime, rejectRuntime) => {
      settle = resolveRuntime
      reject = rejectRuntime
    })
    this.starting.set(layout.key, result)
    this.operationTail = this.operationTail.then(async () => {
      try {
        const cached = this.runtimes.get(layout.key)
        if (cached !== undefined) {
          settle(cached)
          return
        }
        await this.makeCapacity()
        const runtime = await this.start(layout)
        this.runtimes.set(layout.key, runtime)
        settle(runtime)
      } catch (error) {
        reject(error)
      } finally {
        this.starting.delete(layout.key)
      }
    })
    return result
  }

  /** Evict the least-recent idle child when the configured process bound is full. */
  private async makeCapacity(): Promise<void> {
    if (this.runtimes.size < this.options.maxActiveTenants) return
    const idle = [...this.runtimes.values()]
      .filter(runtime => runtime.active === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
    if (idle === undefined) throw new TenantCapacityError(this.options.maxActiveTenants)
    await this.stop(idle)
  }

  /** Materialize one tenant's roots/patch and wait for its child readiness line. */
  private async start(layout: TenantLayout): Promise<TenantRuntime> {
    const childPatches = [...this.patches]
    if (layout.home !== undefined && layout.dshHome !== undefined && layout.patch !== undefined) {
      await Promise.all([
        mkdir(layout.home, { recursive: true, mode: 0o700 }),
        mkdir(layout.dshHome, { recursive: true, mode: 0o700 }),
      ])
      await writeFile(layout.patch, [
        '- id: directory-picker',
        '  config:',
        `    browseRoot: ${JSON.stringify(layout.home)}`,
        `    uploadRoot: ${JSON.stringify(layout.home)}`,
        '- id: credentials',
        '  config:',
        `    fallbackPath: ${JSON.stringify(this.defaultCredentialsPath)}`,
        '',
      ].join('\n'), { mode: 0o600 })
      childPatches.push(layout.patch)
    }
    const args = [
      ...this.childExecArgv,
      '--import', tenantChdirImport(layout.cwd),
      this.options.entrypoint,
      '--profile', 'web',
      ...childPatches.flatMap(path => ['--patch', path]),
      '--host', '127.0.0.1', '--port', '0',
    ]
    const env = { ...process.env }
    if (layout.home !== undefined && layout.dshHome !== undefined) {
      env.HOME = layout.home
      env.USERPROFILE = layout.home
      env.DSH_HOME = layout.dshHome
    }
    const child = spawn(process.execPath, args, { cwd: this.originalCwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const label = layout.key === DEFAULT_COOKIE_VALUE ? 'default' : layout.key.slice(0, 12)
    child.stderr.on('data', (chunk: string) => { process.stderr.write(`[tenant ${label}] ${chunk}`) })
    try {
      const port = await this.readyPort(child, label)
      const runtime: TenantRuntime = { ...layout, child, port, active: 0, lastUsedAt: Date.now() }
      child.once('exit', () => {
        if (this.runtimes.get(layout.key)?.child === child) this.runtimes.delete(layout.key)
      })
      return runtime
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
  }

  /** Parse the child URL readiness signal within the configured startup budget. */
  private readyPort(child: TenantChild, label: string): Promise<number> {
    return new Promise<number>((resolvePort, rejectPort) => {
      let buffer = ''
      let settled = false
      const finish = (error: Error | undefined, port?: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        if (error !== undefined) rejectPort(error)
        else if (port === undefined) rejectPort(new Error('tenant child readiness line carried no port'))
        else {
          if (buffer.trim() !== '') process.stderr.write(`[tenant ${label}] ${buffer}`)
          child.stdout.on('data', (chunk: string) => { process.stderr.write(`[tenant ${label}] ${chunk}`) })
          resolvePort(port)
        }
      }
      const onData = (chunk: string): void => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline === -1) break
          const line = buffer.slice(0, newline).trimEnd()
          buffer = buffer.slice(newline + 1)
          const match = /^dsh web: http:\/\/127\.0\.0\.1:(\d+)/u.exec(line)
          if (match !== null) {
            finish(undefined, Number(match[1]))
            return
          }
          if (line !== '') process.stderr.write(`[tenant ${label}] ${line}\n`)
        }
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(new Error(`tenant child exited before readiness (code=${String(code)}, signal=${String(signal)})`))
      }
      const timer = setTimeout(() => {
        finish(new Error(`tenant child did not become ready within ${String(this.options.startTimeoutMs)}ms`))
      }, this.options.startTimeoutMs)
      timer.unref()
      child.stdout.on('data', onData)
      child.once('exit', onExit)
    })
  }

  /** Remove one cached child and wait briefly for its ordinary SIGTERM shutdown. */
  private async stop(runtime: TenantRuntime): Promise<void> {
    if (this.runtimes.get(runtime.key)?.child !== runtime.child) return
    this.runtimes.delete(runtime.key)
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return
    const exited = new Promise<void>((resolveExit) => { runtime.child.once('exit', () => { resolveExit() }) })
    runtime.child.kill('SIGTERM')
    const force = setTimeout(() => { runtime.child.kill('SIGKILL') }, 5_000)
    force.unref()
    await exited
    clearTimeout(force)
  }
}

/** Idempotent request/socket completion hook for one tenant lease. */
function releaseLeaseOnce(lease: TenantLease): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    lease.release()
  }
}

/** Proxy one ordinary HTTP request to its selected private child. */
async function proxyHttp(
  req: IncomingMessage, res: ServerResponse, manager: TenantManager, identifier: TenantIdentifier,
): Promise<void> {
  const lease = await manager.acquire(identifier)
  const release = releaseLeaseOnce(lease)
  res.once('finish', release)
  res.once('close', release)
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: lease.port,
    method: req.method,
    path: req.url,
    headers: childHeaders(req, lease.port),
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(res)
  })
  upstream.once('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`tenant backend unavailable: ${error.message}`)
    } else res.destroy(error)
  })
  req.once('aborted', () => { upstream.destroy() })
  req.pipe(upstream)
}

/** Proxy one WebSocket upgrade and retain its tenant lease until the socket closes. */
async function proxyUpgrade(
  req: IncomingMessage, socket: Duplex, head: Buffer, manager: TenantManager, identifier: TenantIdentifier,
): Promise<void> {
  const lease = await manager.acquire(identifier)
  const release = releaseLeaseOnce(lease)
  const upstream = connect(lease.port, '127.0.0.1')
  socket.once('close', release)
  upstream.once('close', release)
  upstream.once('connect', () => {
    upstream.write(childUpgradeHead(req, lease.port))
    if (head.byteLength > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.once('error', (error) => {
    if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    else socket.destroy(error)
  })
  socket.once('error', () => { upstream.destroy() })
}

/** Start the selector gateway and own its children until SIGINT/SIGTERM. */
export async function runTenantWeb(options: TenantWebOptions): Promise<number> {
  const manager = new TenantManager(options)
  const upgradedSockets = new Set<Duplex>()
  const server: Server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://tenant-web').pathname
      if (pathname === TENANT_RESET_PATH) {
        res.writeHead(303, { location: TENANT_SELECTOR_PATH, 'set-cookie': selectionCookie(req, '', 0), 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (pathname === TENANT_DEFAULT_PATH) {
        res.writeHead(303, {
          location: '/',
          'set-cookie': selectionCookie(req, encodeTenantCookie(null)),
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
      if (pathname === TENANT_CURRENT_PATH) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        const identifier = requestIdentifier(req)
        const state: TenantSelectionState = identifier === undefined
          ? { selected: false }
          : { selected: true, identifier }
        serveJson(res, 200, state)
        return
      }
      if (pathname === TENANT_SELECT_PATH) {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        try {
          const identifier = await readIdentifierForm(req)
          res.writeHead(303, { location: '/', 'set-cookie': selectionCookie(req, encodeTenantCookie(identifier)), 'cache-control': 'no-store' })
          res.end()
        } catch (error) {
          serveSelector(res, 400, error instanceof Error ? error.message : String(error))
        }
        return
      }
      if (pathname === TENANT_SELECTOR_PATH) {
        serveSelector(res)
        return
      }
      const identifier = requestIdentifier(req)
      if (identifier === undefined) {
        serveSelector(res)
        return
      }
      try {
        await proxyHttp(req, res, manager, identifier)
      } catch (error) {
        const status = error instanceof TenantCapacityError ? 503 : 502
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(error instanceof Error ? error.message : String(error))
      }
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(error instanceof Error ? error.message : String(error))
    })
  })
  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket)
    socket.once('close', () => { upgradedSockets.delete(socket) })
    const identifier = requestIdentifier(req)
    if (identifier === undefined) {
      socket.end('HTTP/1.1 428 Precondition Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    void proxyUpgrade(req, socket, head, manager, identifier).catch((error: unknown) => {
      socket.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port, options.host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port
  console.log(`dsh tenant-web: http://${options.host}:${String(port)}`)
  return await new Promise<number>((resolveExit) => {
    let closing = false
    const close = (code: number): void => {
      if (closing) return
      closing = true
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInterrupt)
      server.close(() => {
        void manager.dispose().then(() => { resolveExit(code) })
      })
      server.closeAllConnections()
      for (const socket of upgradedSockets) socket.destroy()
    }
    const onTerm = (): void => { close(0) }
    const onInterrupt = (): void => { close(130) }
    process.on('SIGTERM', onTerm)
    process.on('SIGINT', onInterrupt)
  })
}
