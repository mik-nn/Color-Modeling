// src/lib/experiments/kSweep.worker.ts
// Web Worker for running k-sweep off the main thread.
// Receives a start message, posts progress + result.

import type { ProfileData } from '../../types'
import { runKSweep, type KSweepOptions, type KSweepResult } from './kSweep'

export interface WorkerStartMessage {
  type: 'start'
  profiles: ProfileData[]
  opts: Omit<KSweepOptions, 'onProgress'>
}

export interface WorkerProgressMessage {
  type: 'progress'
  done: number
  total: number
}

export interface WorkerDoneMessage {
  type: 'done'
  result: KSweepResult
}

export interface WorkerErrorMessage {
  type: 'error'
  message: string
}

export type WorkerOutMessage =
  | WorkerProgressMessage
  | WorkerDoneMessage
  | WorkerErrorMessage

self.onmessage = (event: MessageEvent<WorkerStartMessage>) => {
  const { profiles, opts } = event.data
  try {
    const result = runKSweep(profiles, {
      ...opts,
      onProgress: (done, total) => {
        self.postMessage({ type: 'progress', done, total } satisfies WorkerProgressMessage)
      },
    })
    self.postMessage({ type: 'done', result } satisfies WorkerDoneMessage)
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerErrorMessage)
  }
}
