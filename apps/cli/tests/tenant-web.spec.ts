import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeTenantCookie, defaultSkinMarkerPath, encodeTenantCookie, ensureDefaultTenantSkin, normalizeTenantIdentifier,
  portableChildExecArgv, resolveTenantChildEnvironment, resolveTenantImageQueueRoot, resolveTenantLayout,
  tenantChdirImport, tenantDirectoryKey, tenantSelectorHtml,
} from '../src/tenant-web.ts'

describe('tenant Web identifier contract', () => {
  it('normalizes compatibility spelling and maps blank input to the default tenant', () => {
    expect(normalizeTenantIdentifier('   ')).toBeNull()
    expect(normalizeTenantIdentifier('  Alice  ')).toBe('Alice')
    expect(normalizeTenantIdentifier('Ａｌｉｃｅ')).toBe('Alice')
    expect(normalizeTenantIdentifier('Alice')).not.toBe(normalizeTenantIdentifier('alice'))
    expect(() => normalizeTenantIdentifier('a'.repeat(65))).toThrow('最多 64 个字符')
    expect(() => normalizeTenantIdentifier('line\nbreak')).toThrow('控制字符')
  })

  it('round-trips canonical cookies and rejects malformed or non-normalized values', () => {
    expect(decodeTenantCookie(encodeTenantCookie(null))).toBeNull()
    expect(decodeTenantCookie(encodeTenantCookie('用户-A'))).toBe('用户-A')
    expect(decodeTenantCookie('not+base64')).toBeUndefined()
    expect(decodeTenantCookie(Buffer.from(' Alice ', 'utf8').toString('base64url'))).toBeUndefined()
  })

  it('uses a stable hash directory without putting the identifier in filesystem paths', () => {
    const key = tenantDirectoryKey('customer@example.com')
    expect(key).toMatch(/^[0-9a-f]{64}$/u)
    const named = resolveTenantLayout('customer@example.com', '/srv/dsh-tenants', '/workspace/default')
    expect(named).toEqual({
      key,
      cwd: join('/srv/dsh-tenants', 'v1', key, 'home'),
      home: join('/srv/dsh-tenants', 'v1', key, 'home'),
      dshHome: join('/srv/dsh-tenants', 'v1', key, '.dsh'),
      patch: join('/srv/dsh-tenants', 'v1', key, 'tenant.patch.yml'),
    })
    expect(JSON.stringify(named)).not.toContain('customer@example.com')
    expect(resolveTenantLayout(null, '/srv/dsh-tenants', '/workspace/default'))
      .toEqual({ key: 'default', cwd: '/workspace/default' })
  })

  it('renders a script-free blocking selector with the blank-default contract', () => {
    const html = tenantSelectorHtml('<invalid>')
    expect(html).toContain('留空进入默认空间')
    expect(html).toContain('action="/__dsh_tenant/select"')
    expect(html).toContain('&lt;invalid&gt;')
    expect(html).not.toContain('<script')
  })

  it('makes source-mode preload operands portable across tenant working directories', () => {
    const [flag, moduleUrl, inline] = portableChildExecArgv(
      ['--import', 'tsx/esm', '--loader=./loader.mjs'],
      '/srv/harness',
    )
    expect(flag).toBe('--import')
    expect(moduleUrl).toMatch(/^file:.*tsx.*esm/u)
    expect(inline).toBe('--loader=file:///srv/harness/loader.mjs')
    expect(decodeURIComponent(tenantChdirImport('/srv/tenant home').slice('data:text/javascript,'.length)))
      .toBe('process.chdir("/srv/tenant home")')
  })

  it('keeps one parent-owned image queue while isolating default and named tenant keys', () => {
    const parentDshHome = '/srv/parent/.dsh'
    const fallbackRoot = resolveTenantImageQueueRoot(parentDshHome)
    expect(fallbackRoot).toBe('/srv/parent/.dsh/codex-image-proxy-shared/v1')
    expect(resolveTenantImageQueueRoot(parentDshHome, '/srv/worker/shared/v1'))
      .toBe('/srv/worker/shared/v1')
    expect(resolveTenantImageQueueRoot(parentDshHome, '   ')).toBe(fallbackRoot)

    const defaultLayout = resolveTenantLayout(null, '/srv/tenants', '/workspace/default')
    const namedLayout = resolveTenantLayout('Alice', '/srv/tenants', '/workspace/default')
    const defaultEnv = resolveTenantChildEnvironment(defaultLayout, fallbackRoot, { HOME: '/parent' })
    const namedEnv = resolveTenantChildEnvironment(namedLayout, fallbackRoot, { HOME: '/parent' })

    expect(defaultEnv).toMatchObject({
      HOME: '/parent',
      DSH_CODEX_IMAGE_QUEUE_ROOT: fallbackRoot,
      DSH_TENANT_KEY: 'default',
    })
    expect(namedEnv).toMatchObject({
      HOME: namedLayout.home,
      DSH_HOME: namedLayout.dshHome,
      DSH_CODEX_IMAGE_QUEUE_ROOT: fallbackRoot,
      DSH_TENANT_KEY: tenantDirectoryKey('Alice'),
    })
  })

  it('seeds a default skin once per isolated Harness home and waits for its boot manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-tenant-skin-'))
    let applyCalls = 0
    let documentCalls = 0
    const server = createServer((request, response) => {
      if (request.url === '/api/skin-center/apply' && request.method === 'POST') {
        applyCalls += 1
        request.resume()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, active: 'maid-atelier' }))
        return
      }
      documentCalls += 1
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(documentCalls < 2
        ? '<html></html>'
        : '<script src="/plugins/@linxin666/dsh-client-ui-skin-maid-atelier/client.js"></script>')
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    try {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('test server has no TCP address')
      await expect(ensureDefaultTenantSkin(home, address.port, 'maid-atelier', {
        manifestAttempts: 3,
        manifestIntervalMs: 1,
      })).resolves.toBe(true)
      await expect(readFile(defaultSkinMarkerPath(home), 'utf8'))
        .resolves.toBe('{"version":1,"skin":"maid-atelier"}\n')
      await expect(ensureDefaultTenantSkin(home, address.port, 'maid-atelier', {
        manifestAttempts: 1,
        manifestIntervalMs: 1,
      })).resolves.toBe(false)
      expect(applyCalls).toBe(1)
      expect(documentCalls).toBe(2)
    } finally {
      await new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) })
      await rm(home, { recursive: true, force: true })
    }
  })
})
