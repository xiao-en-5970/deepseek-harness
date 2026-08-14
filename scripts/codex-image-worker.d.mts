export interface WorkerOptions {
  sandbox: string
  queueRoot: string
  pollSeconds: number
  leaseSeconds: number
  concurrency: number
  maxImageBytes: number
  bohrBin: string
  codexBin: string
  once: boolean
}

export interface GeneratedImage {
  path: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  extension: 'png' | 'jpg' | 'gif' | 'webp'
  bytes: number
  sha256: string
}

export interface WorkerRequest {
  status?: string
  requestId?: string
  tenantKey?: string
  prompt?: string
  [key: string]: unknown
}

export interface WorkerLoopInternals {
  claim?: () => Promise<WorkerRequest>
  process?: (request: WorkerRequest) => Promise<void>
  sleep?: (milliseconds: number) => Promise<void>
}

export function parseWorkerArgs(argv: string[]): WorkerOptions
export function findGeneratedImage(workdir: string, startedAt: number, maxImageBytes: number): Promise<GeneratedImage>
export function runWorkerLoop(options: WorkerOptions, workerId: string, internals?: WorkerLoopInternals): Promise<number>
export function main(argv?: string[]): Promise<number>
