import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeTenantCookie, encodeTenantCookie, normalizeTenantIdentifier,
  portableChildExecArgv, resolveTenantLayout, tenantChdirImport, tenantDirectoryKey, tenantSelectorHtml,
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
})
