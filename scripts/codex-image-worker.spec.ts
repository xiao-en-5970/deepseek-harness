import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findGeneratedImage, parseWorkerArgs, runWorkerLoop } from './codex-image-worker.mjs'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('local Codex image worker', () => {
  it('requires a sandbox and validates numeric and remote-path options', () => {
    expect(() => parseWorkerArgs([])).toThrow('--sandbox is required')
    expect(() => parseWorkerArgs(['--sandbox', 's', '--queue-root', 'relative'])).toThrow('absolute sandbox path')
    expect(() => parseWorkerArgs(['--sandbox', 's', '--poll-seconds', '0'])).toThrow('positive integer')
    expect(() => parseWorkerArgs(['--sandbox', 's', '--concurrency', '1.5'])).toThrow('positive integer')
    expect(parseWorkerArgs(['--sandbox', 's', '--once'])).toMatchObject({
      sandbox: 's', once: true, pollSeconds: 10, leaseSeconds: 60, concurrency: 2,
    })
    expect(parseWorkerArgs(['--', '--sandbox', 's', '--once']).sandbox).toBe('s')
  })

  it('runs independent image generations in a bounded parallel pool', async () => {
    const options = parseWorkerArgs(['--sandbox', 's', '--concurrency', '2', '--poll-seconds', '1'])
    const requests = [
      { requestId: 'one', prompt: 'one' },
      { requestId: 'two', prompt: 'two' },
      { requestId: 'three', prompt: 'three' },
    ]
    let active = 0
    let maximum = 0
    let completed = 0
    const loop = runWorkerLoop(options, 'worker', {
      claim: async () => requests.shift() ?? { status: 'idle' },
      process: async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise(resolveProcess => setTimeout(resolveProcess, 5))
        active--
        completed++
      },
      sleep: async () => {
        while (completed < 3) await new Promise(resolveSleep => setTimeout(resolveSleep, 1))
        throw new Error('test-stop')
      },
    })
    await expect(loop).rejects.toThrow('test-stop')
    expect(maximum).toBe(2)
    expect(completed).toBe(3)
  })

  it('accepts a bounded PNG copied into the Codex work directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-worker-test-'))
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    await writeFile(join(root, 'result.png'), bytes)
    const image = await findGeneratedImage(root, Date.now() - 1_000, 1_024)
    expect(image).toMatchObject({ mimeType: 'image/png', extension: 'png', bytes: bytes.byteLength })
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects unsupported or oversized output', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-worker-test-'))
    await writeFile(join(root, 'result.png'), 'not an image')
    await expect(findGeneratedImage(root, Date.now() - 1_000, 1_024)).rejects.toThrow('not a supported')
  })
})
