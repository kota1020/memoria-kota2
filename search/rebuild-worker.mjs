#!/usr/bin/env node
// Detached, single-flight index rebuild used after MCP writes.

import { existsSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { buildIndex } from './index.mjs'

const lockPath = process.argv[2]
const pendingPath = process.argv[3]
for (;;) {
  try {
    while (pendingPath && existsSync(pendingPath)) {
      try { unlinkSync(pendingPath) } catch {}
      buildIndex()
    }
  } finally {
    if (lockPath) {
      try { rmdirSync(lockPath) } catch {}
    }
  }
  if (!pendingPath || !existsSync(pendingPath)) break
  try { mkdirSync(lockPath, { mode: 0o700 }) } catch { break }
}
