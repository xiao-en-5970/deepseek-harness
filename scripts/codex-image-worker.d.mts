export interface WorkerOptions {
  sandbox: string
  queueRoot: string
  pollSeconds: number
  leaseSeconds: number
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

export function parseWorkerArgs(argv: string[]): WorkerOptions
export function findGeneratedImage(workdir: string, startedAt: number, maxImageBytes: number): Promise<GeneratedImage>
export function main(argv?: string[]): Promise<number>
