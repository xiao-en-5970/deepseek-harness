#!/usr/bin/env node
/**
 * Local Codex image worker for DeepSeek Harness.
 *
 * The worker keeps all Codex credentials on this machine. It reaches the
 * sandbox only through the authenticated `bohr sandbox` CLI, claims one
 * durable request, runs `$imagegen` via `codex exec`, uploads the image, and
 * atomically publishes the result record.
 */

import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, posix, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_POLL_SECONDS = 10
export const DEFAULT_LEASE_SECONDS = 60
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const DEFAULT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex'

const IMAGE_TYPES = [
  { mimeType: 'image/png', extension: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mimeType: 'image/jpeg', extension: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) },
  { mimeType: 'image/gif', extension: 'gif', signature: Buffer.from('GIF8') },
  { mimeType: 'image/webp', extension: 'webp', signature: Buffer.from('RIFF'), trailer: Buffer.from('WEBP') },
]

const REMOTE_QUEUE_PROGRAM = String.raw`
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const root = path.resolve(process.env.DSH_IMAGE_QUEUE_ROOT || '')
const op = process.env.DSH_IMAGE_OP || ''
const now = Date.now()
const workerId = process.env.DSH_IMAGE_WORKER_ID || ''
const version = 1

if (!path.isAbsolute(root) || workerId === '') throw new Error('invalid queue root or worker id')

async function atomicJson(target, value) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = target + '.' + crypto.randomUUID() + '.tmp'
  try {
    await fsp.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    await fsp.rename(temporary, target)
  } finally {
    await fsp.unlink(temporary).catch(() => {})
  }
}

async function heartbeat(status, requestId) {
  await fsp.mkdir(path.join(root, 'tenants'), { recursive: true, mode: 0o700 })
  await atomicJson(path.join(root, 'heartbeat.json'), {
    version, workerId, status, ...(requestId ? { requestId } : {}), updatedAt: Date.now(),
  })
}

function tenantRoot(tenantKey) {
  if (!/^(?:default|[0-9a-f]{64})$/.test(tenantKey)) throw new Error('invalid tenant key')
  return path.join(root, 'tenants', tenantKey)
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

async function exists(file) {
  return fsp.access(file).then(() => true, () => false)
}

async function failExpired(dir, file, request) {
  const requestId = request.requestId
  await atomicJson(path.join(dir, 'results', requestId + '.json'), {
    version, requestId, status: 'failed', message: 'Image request expired before a worker could start it.', completedAt: Date.now(),
  })
  await fsp.unlink(file).catch(() => {})
}

async function claim() {
  await heartbeat('idle')
  const tenantsRoot = path.join(root, 'tenants')
  const tenantEntries = await fsp.readdir(tenantsRoot, { withFileTypes: true }).catch(() => [])
  const leaseMs = Math.max(1, Number(process.env.DSH_IMAGE_LEASE_MS || 60000))
  for (const entry of tenantEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^(?:default|[0-9a-f]{64})$/.test(entry.name)) continue
    const dir = path.join(tenantsRoot, entry.name)
    const pending = path.join(dir, 'pending')
    const claimed = path.join(dir, 'claimed')
    const cancelled = path.join(dir, 'cancelled')
    await Promise.all([
      fsp.mkdir(pending, { recursive: true, mode: 0o700 }),
      fsp.mkdir(claimed, { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(dir, 'results'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(dir, 'images'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(cancelled, { recursive: true, mode: 0o700 }),
    ])
    const staleClaims = await fsp.readdir(claimed).catch(() => [])
    for (const name of staleClaims) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      const claimedPath = path.join(claimed, name)
      const info = await fsp.stat(claimedPath).catch(() => undefined)
      if (!info || now - info.mtimeMs <= leaseMs) continue
      const requestId = name.slice(0, -5)
      if (await exists(path.join(cancelled, name))) await fsp.unlink(claimedPath).catch(() => {})
      else await fsp.rename(claimedPath, path.join(pending, name)).catch(() => {})
    }
    const names = await fsp.readdir(pending).catch(() => [])
    for (const name of names.sort()) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      const requestId = name.slice(0, -5)
      const from = path.join(pending, name)
      if (await exists(path.join(cancelled, name))) {
        await fsp.unlink(from).catch(() => {})
        continue
      }
      let request
      try { request = await readJson(from) } catch { continue }
      if (request.version !== version || request.requestId !== requestId || request.tenantKey !== entry.name) continue
      if (typeof request.expiresAt !== 'number' || request.expiresAt <= Date.now()) {
        await failExpired(dir, from, request)
        continue
      }
      const to = path.join(claimed, name)
      try { await fsp.rename(from, to) } catch { continue }
      await fsp.utimes(to, new Date(), new Date())
      await heartbeat('busy', requestId)
      process.stdout.write(JSON.stringify(request) + '\n')
      return
    }
  }
  process.stdout.write(JSON.stringify({ status: 'idle' }) + '\n')
}

async function renew() {
  const tenantKey = process.env.DSH_IMAGE_TENANT_KEY || ''
  const requestId = process.env.DSH_IMAGE_REQUEST_ID || ''
  const claim = path.join(tenantRoot(tenantKey), 'claimed', requestId + '.json')
  await heartbeat('busy', requestId)
  await fsp.utimes(claim, new Date(), new Date()).catch(() => {})
  process.stdout.write(JSON.stringify({ status: 'renewed' }) + '\n')
}

async function finalize() {
  const tenantKey = process.env.DSH_IMAGE_TENANT_KEY || ''
  const requestId = process.env.DSH_IMAGE_REQUEST_ID || ''
  const mimeType = process.env.DSH_IMAGE_MIME_TYPE || ''
  const extension = process.env.DSH_IMAGE_EXTENSION || ''
  const expectedBytes = Number(process.env.DSH_IMAGE_BYTES || '')
  const expectedSha = process.env.DSH_IMAGE_SHA256 || ''
  const temporary = process.env.DSH_IMAGE_TEMP_PATH || ''
  if (!/^[0-9a-f-]{36}$/.test(requestId) || !/^(?:png|jpg|gif|webp)$/.test(extension)) throw new Error('invalid image result identity')
  if (!/^image\/(?:png|jpeg|gif|webp)$/.test(mimeType) || !/^[0-9a-f]{64}$/.test(expectedSha)) throw new Error('invalid image result metadata')
  const dir = tenantRoot(tenantKey)
  const claim = path.join(dir, 'claimed', requestId + '.json')
  const cancellation = path.join(dir, 'cancelled', requestId + '.json')
  if (await exists(cancellation)) {
    await Promise.all([fsp.unlink(claim).catch(() => {}), fsp.unlink(temporary).catch(() => {})])
    process.stdout.write(JSON.stringify({ status: 'cancelled' }) + '\n')
    return
  }
  if (!await exists(claim)) throw new Error('request claim no longer exists')
  const bytes = await fsp.readFile(temporary)
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== expectedBytes || sha256 !== expectedSha) throw new Error('uploaded image metadata mismatch')
  const image = path.join(dir, 'images', requestId + '.' + extension)
  await fsp.rename(temporary, image)
  await atomicJson(path.join(dir, 'results', requestId + '.json'), {
    version, requestId, status: 'completed', mimeType, bytes: bytes.byteLength, sha256, completedAt: Date.now(),
  })
  await fsp.unlink(claim).catch(() => {})
  await heartbeat('idle')
  process.stdout.write(JSON.stringify({ status: 'completed' }) + '\n')
}

async function fail() {
  const tenantKey = process.env.DSH_IMAGE_TENANT_KEY || ''
  const requestId = process.env.DSH_IMAGE_REQUEST_ID || ''
  const message = (process.env.DSH_IMAGE_FAILURE || 'Local Codex image generation failed.').slice(0, 4000)
  const dir = tenantRoot(tenantKey)
  if (!await exists(path.join(dir, 'cancelled', requestId + '.json'))) {
    await atomicJson(path.join(dir, 'results', requestId + '.json'), {
      version, requestId, status: 'failed', message, completedAt: Date.now(),
    })
  }
  await fsp.unlink(path.join(dir, 'claimed', requestId + '.json')).catch(() => {})
  await heartbeat('idle')
  process.stdout.write(JSON.stringify({ status: 'failed' }) + '\n')
}

Promise.resolve()
  .then(() => op === 'claim' ? claim() : op === 'renew' ? renew() : op === 'finalize' ? finalize() : op === 'fail' ? fail() : Promise.reject(new Error('unknown queue operation')))
  .catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exitCode = 1 })
`

/** Parse the worker's intentionally small command line. */
export function parseWorkerArgs(argv) {
  const values = {
    sandbox: '',
    queueRoot: '/root/.dsh/codex-image-proxy-shared/v1',
    pollSeconds: DEFAULT_POLL_SECONDS,
    leaseSeconds: DEFAULT_LEASE_SECONDS,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    bohrBin: process.env.BOHR_BIN || 'bohr',
    codexBin: process.env.CODEX_BIN || DEFAULT_CODEX_BIN,
    once: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--') continue
    if (key === '--once') {
      values.once = true
      continue
    }
    const next = argv[++index]
    if (next === undefined) throw new Error(`missing value for ${key}`)
    switch (key) {
      case '--sandbox': values.sandbox = next; break
      case '--queue-root': values.queueRoot = next; break
      case '--poll-seconds': values.pollSeconds = Number(next); break
      case '--lease-seconds': values.leaseSeconds = Number(next); break
      case '--max-image-bytes': values.maxImageBytes = Number(next); break
      case '--bohr-bin': values.bohrBin = next; break
      case '--codex-bin': values.codexBin = next; break
      default: throw new Error(`unknown argument: ${key}`)
    }
  }
  if (values.sandbox.trim() === '') throw new Error('--sandbox is required')
  if (!posix.isAbsolute(values.queueRoot)) throw new Error('--queue-root must be an absolute sandbox path')
  for (const [name, value] of [['poll-seconds', values.pollSeconds], ['lease-seconds', values.leaseSeconds], ['max-image-bytes', values.maxImageBytes]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`)
  }
  return values
}

function sleep(milliseconds) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
}

async function spawnCaptured(command, args, options = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => {
      stderr.push(Buffer.from(chunk))
      if (options.echoStderr) process.stderr.write(chunk)
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function remoteCommand() {
  const source = Buffer.from(REMOTE_QUEUE_PROGRAM, 'utf8').toString('base64')
  return `node -e "eval(Buffer.from('${source}','base64').toString())"`
}

/** Run one queue operation through the authenticated sandbox CLI. */
export async function runRemote(options, workerId, op, extraEnv = {}) {
  const env = {
    DSH_IMAGE_QUEUE_ROOT: options.queueRoot,
    DSH_IMAGE_WORKER_ID: workerId,
    DSH_IMAGE_OP: op,
    DSH_IMAGE_LEASE_MS: String(options.leaseSeconds * 1_000),
    ...extraEnv,
  }
  const args = ['sandbox', 'exec', options.sandbox, '-o', 'json']
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
  args.push('--command', remoteCommand())
  const run = await spawnCaptured(options.bohrBin, args)
  let envelope
  try { envelope = JSON.parse(run.stdout) } catch { throw new Error(`bohr returned non-JSON output: ${run.stdout || run.stderr}`) }
  const remote = envelope?.data
  if (run.code !== 0 || !envelope?.ok || remote?.exit_code !== 0) {
    throw new Error(remote?.stderr || remote?.error || run.stderr || `bohr exited ${String(run.code)}`)
  }
  const line = String(remote.stdout || '').trim().split('\n').at(-1)
  return line ? JSON.parse(line) : {}
}

function imageType(bytes) {
  for (const type of IMAGE_TYPES) {
    if (!bytes.subarray(0, type.signature.length).equals(type.signature)) continue
    if (type.trailer && !bytes.subarray(8, 12).equals(type.trailer)) continue
    return type
  }
  throw new Error('Codex output is not a supported PNG, JPEG, GIF, or WebP image')
}

async function newestGeneratedImage(after) {
  const root = join(homedir(), '.codex', 'generated_images')
  let newest
  const sessions = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const directory = join(root, session.name)
    const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile() || !/\.(?:png|jpe?g|gif|webp)$/iu.test(file.name)) continue
      const path = join(directory, file.name)
      const info = await stat(path)
      if (info.mtimeMs + 1_000 < after) continue
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs }
    }
  }
  return newest?.path
}

async function existingPath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return undefined
  const path = resolve(candidate)
  try {
    if ((await stat(path)).isFile()) return path
  } catch {}
  return undefined
}

/** Locate and validate the one image produced by a Codex execution. */
export async function findGeneratedImage(workdir, startedAt, maxImageBytes) {
  const candidates = ['result.png', 'result.jpg', 'result.jpeg', 'result.webp', 'result.gif'].map(name => join(workdir, name))
  const finalPath = join(workdir, 'last-message.json')
  try {
    const last = JSON.parse(await readFile(finalPath, 'utf8'))
    if (typeof last?.image_path === 'string') candidates.push(last.image_path)
  } catch {}
  const generated = await newestGeneratedImage(startedAt)
  if (generated) candidates.push(generated)
  for (const candidate of candidates) {
    const path = await existingPath(candidate)
    if (!path) continue
    const bytes = await readFile(path)
    if (bytes.byteLength < 1 || bytes.byteLength > maxImageBytes) continue
    const type = imageType(bytes)
    return {
      path,
      mimeType: type.mimeType,
      extension: type.extension,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  throw new Error('Codex completed without a valid generated image')
}

function codexPrompt(request) {
  const context = request.context ? `\n\nRelevant Harness context:\n${request.context}` : ''
  return [
    '$imagegen',
    '',
    'Generate exactly one image for the request below. Preserve all concrete visual requirements.',
    'Copy the final generated image to ./result.png (or result.jpg/result.webp if that is the actual format).',
    'Then return only JSON matching the supplied output schema, with image_path set to that copied file.',
    '',
    `Image request:\n${request.prompt}${context}`,
  ].join('\n')
}

async function generateWithCodex(options, request, workdir) {
  const schemaPath = join(workdir, 'output-schema.json')
  await writeFile(schemaPath, JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['image_path'],
    properties: { image_path: { type: 'string' } },
  }), 'utf8')
  const startedAt = Date.now()
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules',
    '--sandbox', 'workspace-write', '-C', workdir,
    '--output-schema', schemaPath,
    '--output-last-message', join(workdir, 'last-message.json'),
    codexPrompt(request),
  ]
  const run = await spawnCaptured(options.codexBin, args, { echoStderr: true })
  await writeFile(join(workdir, 'codex-events.jsonl'), run.stdout, 'utf8')
  if (run.code !== 0) throw new Error(`codex exec failed (${String(run.code)}): ${run.stderr.trim().slice(-2000)}`)
  return findGeneratedImage(workdir, startedAt, options.maxImageBytes)
}

async function uploadImage(options, workerId, request, image) {
  const remoteTemporary = posix.join(
    options.queueRoot, 'tenants', request.tenantKey, 'images', `.${request.requestId}.${randomUUID()}.tmp`,
  )
  const upload = await spawnCaptured(options.bohrBin, [
    'sandbox', 'files', 'write', options.sandbox, remoteTemporary,
    '--source', image.path, '-o', 'json',
  ])
  let envelope
  try { envelope = JSON.parse(upload.stdout) } catch { throw new Error(`image upload returned non-JSON output: ${upload.stdout || upload.stderr}`) }
  if (upload.code !== 0 || !envelope?.ok) throw new Error(envelope?.data?.error || upload.stderr || 'image upload failed')
  return runRemote(options, workerId, 'finalize', {
    DSH_IMAGE_TENANT_KEY: request.tenantKey,
    DSH_IMAGE_REQUEST_ID: request.requestId,
    DSH_IMAGE_MIME_TYPE: image.mimeType,
    DSH_IMAGE_EXTENSION: image.extension,
    DSH_IMAGE_BYTES: String(image.bytes),
    DSH_IMAGE_SHA256: image.sha256,
    DSH_IMAGE_TEMP_PATH: remoteTemporary,
  })
}

async function processRequest(options, workerId, request) {
  const workdir = await mkdtemp(join(tmpdir(), 'dsh-codex-image-'))
  let renewing = false
  let stopped = false
  const renew = async () => {
    if (renewing || stopped) return
    renewing = true
    try {
      await runRemote(options, workerId, 'renew', {
        DSH_IMAGE_TENANT_KEY: request.tenantKey,
        DSH_IMAGE_REQUEST_ID: request.requestId,
      })
    } catch (error) {
      console.error(`[codex-image-worker] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      renewing = false
    }
  }
  const timer = setInterval(() => { void renew() }, Math.max(1_000, Math.floor(options.leaseSeconds * 500)))
  try {
    console.log(`[codex-image-worker] generating ${request.requestId}: ${request.prompt.slice(0, 120)}`)
    const generated = await generateWithCodex(options, request, workdir)
    const staged = join(workdir, `upload.${generated.extension}`)
    if (resolve(generated.path) !== resolve(staged)) await copyFile(generated.path, staged)
    await uploadImage(options, workerId, request, { ...generated, path: staged })
    console.log(`[codex-image-worker] completed ${request.requestId} (${String(generated.bytes)} bytes)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[codex-image-worker] failed ${request.requestId}: ${message}`)
    await runRemote(options, workerId, 'fail', {
      DSH_IMAGE_TENANT_KEY: request.tenantKey,
      DSH_IMAGE_REQUEST_ID: request.requestId,
      DSH_IMAGE_FAILURE: message,
    }).catch(failure => {
      console.error(`[codex-image-worker] could not publish failure: ${failure instanceof Error ? failure.message : String(failure)}`)
    })
  } finally {
    stopped = true
    clearInterval(timer)
    while (renewing) await sleep(50)
    await rm(workdir, { recursive: true, force: true })
  }
}

function usage() {
  return [
    'Usage: node scripts/codex-image-worker.mjs --sandbox <id> [options]',
    '',
    'Options:',
    '  --queue-root <absolute sandbox path>  Shared queue root',
    '  --poll-seconds <n>                    Poll interval (default 10)',
    '  --lease-seconds <n>                   Claim lease (default 60)',
    '  --codex-bin <path>                    Local Codex CLI path',
    '  --bohr-bin <path>                     Local bohr CLI path',
    '  --max-image-bytes <n>                 Returned image limit',
    '  --once                                Poll once and exit',
  ].join('\n')
}

/** Worker main loop. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return 0
  }
  const options = parseWorkerArgs(argv)
  if (options.codexBin === DEFAULT_CODEX_BIN) {
    await access(options.codexBin).catch(() => { options.codexBin = 'codex' })
  }
  const workerId = `${basename(process.execPath)}-${randomUUID()}`
  console.log(`[codex-image-worker] sandbox=${options.sandbox} poll=${String(options.pollSeconds)}s worker=${workerId}`)
  for (;;) {
    try {
      const request = await runRemote(options, workerId, 'claim')
      if (request.status !== 'idle') await processRequest(options, workerId, request)
    } catch (error) {
      console.error(`[codex-image-worker] poll failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (options.once) return 0
    await sleep(options.pollSeconds * 1_000)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(code => { process.exitCode = code }, error => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
