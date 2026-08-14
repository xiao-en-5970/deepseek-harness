// Keyless acceptance for the real selector gateway: three browser contexts
// choose independent owners, mutate Workspace and Session state through the
// production HTTP carrier, reconnect, and prove both data and browse roots stay
// disjoint. The source launcher itself is part of the assertion.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './support.ts'

const require = createRequire(import.meta.url)
const tsxLoader = require.resolve('tsx/esm')
const WELCOME_NOTICE_TITLE = '内测声明'
const WELCOME_NOTICE_CONTINUE = '继续'

interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

interface DirectoryListing {
  path: string
  home: string
}

interface CredentialView {
  configured: boolean
  source?: string
  writable: boolean
}

function waitForGateway(child: ChildProcess): Promise<string> {
  return new Promise((resolveReady, rejectReady) => {
    let output = ''
    const timer = setTimeout(() => {
      rejectReady(new Error(`dsh tenant-web not ready in 90s; output:\n${output}`))
    }, 90_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /dsh tenant-web: (http:\/\/[^\s]+)/u.exec(output)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      resolveReady(match[1])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`dsh tenant-web exited early (code ${String(code)}); output:\n${output}`))
    })
  })
}

async function stopGateway(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolveExit) => { child.once('exit', () => { resolveExit() }) })
  child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) => {
      setTimeout(() => {
        child.kill('SIGKILL')
        resolveTimeout()
      }, 10_000).unref()
    }),
  ])
}

async function rpc<T>(page: Page, method: string, payload: unknown): Promise<RpcResult<T>> {
  return await page.evaluate(async ({ rpcMethod, rpcPayload }) => {
    const response = await fetch(`/api/${rpcMethod}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `tenant-e2e-${rpcMethod}`,
        method: rpcMethod,
        payload: rpcPayload,
      }),
    })
    if (!response.ok) throw new Error(`${rpcMethod} returned HTTP ${String(response.status)}`)
    const body = await response.json() as { result: RpcResult<T> }
    return body.result
  }, { rpcMethod: method, rpcPayload: payload })
}

function value<T>(result: RpcResult<T>): T {
  if (!result.ok || result.value === undefined) {
    throw new Error(`${result.error?.code ?? 'rpc-failed'}: ${result.error?.message ?? 'missing value'}`)
  }
  return result.value
}

async function choose(page: Page, baseUrl: string, identifier: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '选择使用空间' }).waitFor({ state: 'visible' })
  await page.getByRole('textbox', { name: '唯一标识符' }).fill(identifier)
  await page.getByRole('button', { name: '进入 DeepSeek Harness' }).click()
  await expect.poll(() => page.title(), { timeout: 90_000 }).toBe('DeepSeek Harness')
}

async function registerWorkspace(page: Page, name: string): Promise<{ home: string; sessionId: string }> {
  const home = value(await rpc<DirectoryListing>(page, 'host.listDirectory', {})).home
  const createdDirectory = value(await rpc<{ path: string }>(page, 'host.createDirectory', { path: home, name })).path
  const workspace = value(await rpc<{ workspace: WorkspaceView }>(page, 'workspace.create', {
    path: createdDirectory,
  })).workspace
  const sessionId = value(await rpc<{ sessionId: string }>(page, 'session.create', {
    workspaceId: workspace.workspaceId,
  })).sessionId
  return { home, sessionId }
}

async function workspaceTitles(page: Page): Promise<string[]> {
  const listed = value(await rpc<{ items: WorkspaceView[] }>(page, 'workspace.list', {}))
  return listed.items.map(item => item.title)
}

async function completeFirstRun(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_TITLE })
  await welcome.waitFor({ state: 'visible', timeout: 15_000 })
  await welcome.getByRole('button', { name: WELCOME_NOTICE_CONTINUE }).click()
  await welcome.waitFor({ state: 'detached', timeout: 15_000 })

  const credentialStep = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
  await credentialStep.waitFor({ state: 'visible', timeout: 15_000 })
  await credentialStep.getByRole('button', { name: '稍后配置' }).click()
  await credentialStep.waitFor({ state: 'detached', timeout: 15_000 })
}

describe('dsh tenant-web keyless process isolation', () => {
  let root: string
  let child: ChildProcess
  let baseUrl: string
  let browser: Browser
  const contexts: BrowserContext[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-tenant-web-e2e-'))
    const defaultHome = join(root, 'default-home')
    const defaultDshHome = join(root, 'default-dsh')
    mkdirSync(defaultHome, { recursive: true })
    mkdirSync(defaultDshHome, { recursive: true })
    child = spawn(process.execPath, [
      '--import', tsxLoader,
      join(REPO_ROOT, 'apps/cli/src/bin.ts'),
      'tenant-web', '--port', '0',
      '--tenant-root', join(root, 'tenants'),
      '--max-active-tenants', '4',
      '--idle-timeout-ms', '120000',
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: defaultHome,
        USERPROFILE: defaultHome,
        DSH_HOME: defaultDshHome,
        DSH_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    baseUrl = await waitForGateway(child)
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await Promise.all(contexts.map(async (context) => { await context.close() }))
    await browser?.close()
    await stopGateway(child)
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  it('blocks before selection and keeps workspace, session, and directory ownership disjoint', async () => {
    const pages: Page[] = []
    for (const identifier of ['Tenant-Alpha', 'Tenant-Beta', '']) {
      const context = await browser.newContext({ locale: 'zh-CN' })
      contexts.push(context)
      const page = await context.newPage()
      pages.push(page)
      await choose(page, baseUrl, identifier)
    }
    const [alpha, beta, defaultPage] = pages as [Page, Page, Page]

    const alphaState = await registerWorkspace(alpha, 'alpha-workspace')
    const betaState = await registerWorkspace(beta, 'beta-workspace')
    const defaultState = await registerWorkspace(defaultPage, 'default-workspace')

    expect(new Set([alphaState.home, betaState.home, defaultState.home]).size).toBe(3)
    expect(new Set([alphaState.sessionId, betaState.sessionId, defaultState.sessionId]).size).toBe(3)
    await expect(workspaceTitles(alpha)).resolves.toEqual(['alpha-workspace'])
    await expect(workspaceTitles(beta)).resolves.toEqual(['beta-workspace'])
    await expect(workspaceTitles(defaultPage)).resolves.toEqual(['default-workspace'])

    const credentialRef = 'DSH_TENANT_E2E_KEY'
    value(await rpc(defaultPage, 'credentials.set', { ref: credentialRef, value: 'default-e2e-value' }))
    await expect.poll(async () => value(await rpc<{ credentials: Record<string, CredentialView> }>(
      alpha, 'credentials.describe', { refs: [credentialRef] },
    )).credentials[credentialRef]).toEqual({ configured: true, source: 'fallback-file', writable: true })
    value(await rpc(alpha, 'credentials.set', { ref: credentialRef, value: 'alpha-e2e-value' }))
    const alphaOwned = value(await rpc<{ credentials: Record<string, CredentialView> }>(
      alpha, 'credentials.describe', { refs: [credentialRef] },
    )).credentials[credentialRef]
    expect(alphaOwned).toEqual({ configured: true, source: 'file', writable: true })
    await expect.poll(async () => value(await rpc<{ credentials: Record<string, CredentialView> }>(
      beta, 'credentials.describe', { refs: [credentialRef] },
    )).credentials[credentialRef]).toEqual({ configured: true, source: 'fallback-file', writable: true })
    value(await rpc(alpha, 'credentials.unset', { ref: credentialRef }))
    const alphaRestored = value(await rpc<{ credentials: Record<string, CredentialView> }>(
      alpha, 'credentials.describe', { refs: [credentialRef] },
    )).credentials[credentialRef]
    expect(alphaRestored).toEqual({ configured: true, source: 'fallback-file', writable: true })

    const outside = await rpc<DirectoryListing>(alpha, 'host.listDirectory', { path: REPO_ROOT })
    expect(outside).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })

    await Promise.all(pages.map(async (page) => { await page.reload({ waitUntil: 'load' }) }))
    await expect(workspaceTitles(alpha)).resolves.toEqual(['alpha-workspace'])
    await expect(workspaceTitles(beta)).resolves.toEqual(['beta-workspace'])
    await expect(workspaceTitles(defaultPage)).resolves.toEqual(['default-workspace'])

    await completeFirstRun(alpha)
    await alpha.getByRole('button', { name: '设置' }).click()
    await alpha.getByTestId('tenant-identity-row').waitFor({ state: 'visible' })
    await alpha.getByText('当前：Tenant-Alpha').waitFor({ state: 'visible' })
    await alpha.getByRole('link', { name: '切回默认空间' }).click()
    await expect.poll(() => workspaceTitles(alpha)).toEqual(['default-workspace'])

    await completeFirstRun(alpha)
    await alpha.getByRole('button', { name: '设置' }).click()
    await alpha.getByRole('link', { name: '切换标识符' }).click()
    await alpha.getByRole('heading', { name: '选择使用空间' }).waitFor({ state: 'visible' })

    value(await rpc(defaultPage, 'credentials.unset', { ref: credentialRef }))
  }, 180_000)
})
