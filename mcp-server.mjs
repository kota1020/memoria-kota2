#!/usr/bin/env node
// Memoria Kota v2 MCP bridge.
//
// The original Swift MCP reads the legacy Memoria SQLite database. This bridge
// keeps the same local stdio/consent boundary, but serves the live Kota v2 task
// understanding and its judgment ledger. stdout is JSON-RPC only.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.MEMORIA_KOTA_ROOT || scriptDir
const memoriaHome = process.env.MEMORIA_HOME || path.join(homedir(), 'Library/Application Support/Memoria')
const consentPath = path.join(memoriaHome, 'mcp.json')
const apiBase = process.env.MEMORIA2_API_URL || 'http://127.0.0.1:4319'
const allMemoryPath = path.join(root, 'knowledge/all.jsonl')
const openJudgmentsPath = path.join(root, 'connect/judgments-open.jsonl')
const lockPath = path.join(root, 'connect/.mcp-write-lock')
const fullScopes = new Set(['activity_content', 'working_content', 'deliverable_content'])

function stderr(message) { process.stderr.write(`${message}\n`) }
function parseArgs(argv) {
  let profile = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') profile = argv[++i] || ''
    else if (argv[i] === '--help' || argv[i] === '-h') {
      stderr('memoria-mcp --profile <profile_id>')
      process.exit(0)
    } else {
      stderr(`memoria-mcp: unknown argument: ${argv[i]}`)
      process.exit(2)
    }
  }
  return profile
}

function readJSON(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function readText(file) { try { return readFileSync(file, 'utf8') } catch { return '' } }
function isoMtime(file) { try { return statSync(file).mtime.toISOString() } catch { return null } }
function atomicJSON(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}
function appendJSONL(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch {}
}
function readJSONL(file) {
  return readText(file).split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}
function withWriteLock(fn) {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + 5000
  for (;;) {
    try { mkdirSync(lockPath, { mode: 0o700 }); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          rmdirSync(lockPath)
          continue
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('write_lock_timeout')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { return fn() } finally { try { rmdirSync(lockPath) } catch {} }
}

const profileID = parseArgs(process.argv.slice(2))
const consent = readJSON(consentPath, null)
const profile = consent?.enabled && consent.profiles?.find(p => p.profile_id === profileID && p.enabled && p.surface !== 'remote')
if (!profileID || !profile) {
  stderr('memoria-mcp: consent_required')
  process.exit(3)
}
const scopes = new Set(profile.scopes || [])
const allowedClients = new Set(profile.allowed_client_names || [])
const canWrite = scopes.has('memory_write')
const canReadActivity = [...fullScopes].some(scope => scopes.has(scope))

function disclosureLevel(value) {
  const level = value || 'context'
  if (!['intent', 'context', 'full'].includes(level)) throw new Error('invalid_disclosure')
  if (level === 'full' && !canReadActivity) throw new Error('activity_content_not_allowed')
  return level
}
function shapeTask(task, disclosure) {
  const value = { name: task.name, status: task.status }
  if (disclosure !== 'intent') {
    value.goal = task.goal
    value.apps = task.apps
    if (task.spans) value.spans = task.spans
    if (task.last_active) value.last_active = task.last_active
    if (task.started) value.started = task.started
  }
  if (disclosure === 'full' && task.evidence) value.evidence = task.evidence
  return value
}
function currentTasks() {
  return readJSON(path.join(root, 'state/open-tasks.json'), { open_tasks: [] }).open_tasks || []
}
function screenContext(disclosure) {
  if (disclosure === 'intent') return undefined
  const raw = readText(process.env.MEMORIA_SCREEN_MEMO || path.join(root, 'kota/current-activity.md'))
  if (!raw) return undefined
  if (disclosure === 'full') return raw.slice(0, 64 * 1024)
  return raw.split('\n').filter(line => line.startsWith('### ') || line.startsWith('ターミナル[')).slice(0, 12)
}
function currentContext(args = {}) {
  const disclosure = disclosureLevel(args.disclosure)
  return {
    disclosure,
    tasks: currentTasks().map(task => shapeTask(task, disclosure)),
    screen: screenContext(disclosure),
    task_updated_at: isoMtime(path.join(root, 'state/open-tasks.json')),
    screen_updated_at: isoMtime(path.join(root, 'kota/current-activity.md')),
    ts: new Date().toISOString(),
  }
}
function tasksAt(iso, disclosure) {
  const time = Date.parse(/[+Z]/.test(iso) ? iso : `${iso.replace(' ', 'T')}+09:00`)
  if (Number.isNaN(time)) throw new Error('invalid_time')
  return readJSONL(path.join(root, 'tasks/tasks-index.jsonl'))
    .filter(task => (task.spans || []).some(([start, end]) => Date.parse(start) <= time && time <= Date.parse(end)))
    .map(task => shapeTask(task, disclosure))
}
function rebuildSearch() {
  const rebuildLock = path.join(root, 'search/.mcp-rebuild-lock')
  const pending = path.join(root, 'search/.mcp-rebuild-pending')
  writeFileSync(pending, `${Date.now()}\n`, { mode: 0o600 })
  try {
    mkdirSync(rebuildLock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') return
    stderr(`memoria-mcp: search rebuild not started (${error.code || 'error'})`)
    return
  }
  try {
    const worker = spawn(process.execPath, [path.join(root, 'search/rebuild-worker.mjs'), rebuildLock, pending], {
      cwd: root, stdio: 'ignore', detached: true,
    })
    worker.once('error', () => { try { rmdirSync(rebuildLock) } catch {} })
    worker.once('exit', code => { if (code) { try { rmdirSync(rebuildLock) } catch {} } })
    worker.unref()
  } catch (error) {
    try { rmdirSync(rebuildLock) } catch {}
    stderr(`memoria-mcp: search rebuild not started (${error.code || 'error'})`)
  }
}
async function recall(query, limit, disclosure) {
  const url = new URL('/recall', apiBase)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('disclosure', disclosure)
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  const body = await response.text()
  if (!response.ok) throw new Error(`Memoria recall API ${response.status}: ${body}`)
  const parsed = JSON.parse(body)
  const hits = parsed.hits ?? parsed.results ?? parsed
  return hits.map(hit => ({
    score: Number(Number(hit.score || 0).toFixed(3)), tag: hit.tag,
    text: disclosure === 'intent' ? String(hit.text || '').slice(0, 140) : hit.text,
    ...(disclosure === 'full' && hit.ref ? { ref: hit.ref } : {}),
  }))
}
function memoryRecord({ id, title, text, type, source, scope, meta }) {
  return {
    source, type, ts: new Date().toISOString(), title, text, url: '',
    meta: JSON.stringify({ id, scope, ...(meta || {}) }),
  }
}
function requireWrite() { if (!canWrite) throw new Error('memory_write_not_allowed') }
function saveMemory(args) {
  requireWrite()
  validateKeys(args, ['statement', 'title', 'type', 'scope'])
  const statement = requiredString(args, 'statement', 4000)
  const type = args.type || 'note'
  if (!['fact', 'preference', 'instruction', 'note'].includes(type)) throw new Error('invalid_type')
  const title = optionalString(args, 'title', 200)
  const scope = optionalString(args, 'scope', 200) || 'global'
  const id = `memory-${randomUUID()}`
  const row = memoryRecord({
    id, title: title || statement.slice(0, 100), text: statement,
    type: `explicit-${type}`, source: `mcp:${profileID}`, scope,
  })
  withWriteLock(() => appendJSONL(allMemoryPath, row))
  rebuildSearch()
  return { id, saved: true, ts: row.ts }
}
function recordJudgment(args) {
  requireWrite()
  validateKeys(args, ['decision', 'why', 'context', 'tags'])
  const decision = requiredString(args, 'decision', 2000)
  const why = requiredString(args, 'why', 4000)
  const context = optionalString(args, 'context', 500) || '—'
  const id = `j-${randomUUID()}`
  const row = {
    id, ts: new Date().toISOString(), agent: profileID,
    decision, why, context, tags: stringArray(args.tags),
    outcome: null, verdict: 'pending', outcomeSpec: null,
  }
  const memory = memoryRecord({
    id, title: decision,
    text: `決定:${decision} ／ なぜ:${why} ／ 結果:未確定（pending） ／ 文脈:${row.context} ／ agent:${row.agent}`,
    type: 'judgment-open', source: 'judgment', scope: row.context,
    meta: { agent: row.agent, verdict: row.verdict, context: row.context, tags: row.tags },
  })
  withWriteLock(() => { appendJSONL(allMemoryPath, memory); appendJSONL(openJudgmentsPath, row) })
  rebuildSearch()
  return { id, recorded: true, verdict: 'pending' }
}
function closeJudgment(args) {
  requireWrite()
  validateKeys(args, ['id', 'result', 'verdict'])
  const id = requiredString(args, 'id', 200)
  const result = requiredString(args, 'result', 4000)
  const verdict = args.verdict
  if (!['win', 'loss', 'mixed'].includes(verdict)) throw new Error('invalid_verdict')
  let closed
  withWriteLock(() => {
    const rows = readJSONL(openJudgmentsPath)
    const row = rows.find(item => item.id === id)
    if (!row) throw new Error('judgment_not_found')
    row.outcome = result
    row.verdict = verdict
    row.closedAt = new Date().toISOString()
    const memory = memoryRecord({
      id, title: row.decision,
      text: `決定:${row.decision} ／ なぜ:${row.why} ／ 結果:${result}（${verdict}） ／ 文脈:${row.context} ／ agent:${row.agent}`,
      type: 'judgment-closed', source: 'judgment', scope: row.context,
      meta: { agent: row.agent, verdict, context: row.context, tags: row.tags },
    })
    appendJSONL(allMemoryPath, memory)
    atomicJSONL(openJudgmentsPath, rows.filter(item => item.id !== id))
    closed = row
  })
  rebuildSearch()
  return { id, closed: true, verdict, result, closed_at: closed.closedAt }
}
function atomicJSONL(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 })
  renameSync(tmp, file)
}
function stringArray(value) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean).slice(0, 20).map(item => item.slice(0, 100))
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean).slice(0, 20).map(item => item.slice(0, 100))
  return []
}
function validateKeys(args, allowed) {
  const extra = Object.keys(args).find(key => !allowed.includes(key))
  if (extra) throw new Error(`unknown_argument:${extra}`)
}
function optionalString(args, key, max) {
  const value = args[key]
  if (value == null || value === '') return ''
  if (typeof value !== 'string' || value.length > max) throw new Error(`invalid_${key}`)
  return value.trim()
}
function requiredString(args, key, max) {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid_${key}`)
  return value.trim()
}
async function health() {
  let api = { ok: false, error: 'unreachable' }
  try {
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1200) })
    api = await response.json()
  } catch {}
  const taskFile = path.join(root, 'state/open-tasks.json')
  const screenFile = path.join(root, 'kota/current-activity.md')
  return {
    ok: api.ok === true && existsSync(taskFile), service: 'memoria-kota2-mcp', profile: profileID,
    api, live_tasks: currentTasks().length, task_updated_at: isoMtime(taskFile),
    screen_updated_at: isoMtime(screenFile), scopes: [...scopes].sort(),
  }
}

const readTools = [
  tool('memoria_health', 'Memoriaのライブ接続・鮮度・許可scopeを確認する', {}),
  tool('get_current_context', '現在のタスクと画面文脈を取得する', {
    disclosure: enumProp(['intent', 'context', 'full']),
  }),
  tool('list_tasks', '現在進行中のタスクを一覧する', {
    status: { type: 'string' }, disclosure: enumProp(['intent', 'context', 'full']),
  }),
  tool('recall_memory', 'Memoriaのタスク・明示メモ・判断記録を意味検索する', {
    query: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 25 },
    disclosure: enumProp(['intent', 'context', 'full']),
  }, ['query']),
  tool('get_tasks_at', '指定したJST時刻に行っていたタスクを取得する', {
    time: { type: 'string' }, disclosure: enumProp(['intent', 'context', 'full']),
  }, ['time']),
  tool('get_current_activity', '現在の画面行動メモを取得する。fullは許可scopeが必要', {
    disclosure: enumProp(['context', 'full']),
  }),
  tool('list_open_judgments', '結果待ちの判断記録を一覧する', {}),
]
const writeTools = [
  tool('save_memory', 'ユーザーが明示した事実・好み・指示・メモをMemoriaへ永続保存する', {
    statement: { type: 'string', maxLength: 4000 }, title: { type: 'string', maxLength: 200 },
    type: enumProp(['fact', 'preference', 'instruction', 'note']), scope: { type: 'string', maxLength: 200 },
  }, ['statement']),
  tool('record_judgment', '決定＋なぜを記録し、結果待ち判断としてMemoriaへ保存する', {
    decision: { type: 'string', maxLength: 2000 }, why: { type: 'string', maxLength: 4000 },
    context: { type: 'string', maxLength: 500 },
    tags: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }] },
  }, ['decision', 'why']),
  tool('close_judgment', '結果待ち判断を結果＋win/loss/mixedで閉じる', {
    id: { type: 'string' }, result: { type: 'string', maxLength: 4000 },
    verdict: enumProp(['win', 'loss', 'mixed']),
  }, ['id', 'result', 'verdict']),
]
const tools = scopes.has('task_metadata') ? [...readTools, ...(canWrite ? writeTools : [])] : []
function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }
}
function enumProp(values) { return { type: 'string', enum: values } }

let lifecycle = 'idle'
async function dispatch(name, args) {
  switch (name) {
    case 'memoria_health': return health()
    case 'get_current_context': return currentContext(args)
    case 'list_tasks': {
      const disclosure = disclosureLevel(args.disclosure)
      return currentTasks().filter(task => !args.status || task.status === args.status).map(task => shapeTask(task, disclosure))
    }
    case 'recall_memory': return recall(requiredString(args, 'query', 500), Math.min(args.limit || 8, 25), disclosureLevel(args.disclosure))
    case 'get_tasks_at': {
      const disclosure = disclosureLevel(args.disclosure)
      return { at: args.time, tasks: tasksAt(requiredString(args, 'time', 100), disclosure) }
    }
    case 'get_current_activity': return { disclosure: disclosureLevel(args.disclosure || 'context'), activity: screenContext(disclosureLevel(args.disclosure || 'context')) }
    case 'list_open_judgments': return readJSONL(openJudgmentsPath)
    case 'save_memory': return saveMemory(args)
    case 'record_judgment': return recordJudgment(args)
    case 'close_judgment': return closeJudgment(args)
    default: throw new Error('tool_not_found')
  }
}
function result(id, value) { return { jsonrpc: '2.0', id, result: value } }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } } }
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }

async function handle(line) {
  let request
  try { request = JSON.parse(line) } catch { send(rpcError(null, -32700, 'parse_error')); return }
  const { id, method, params = {} } = request
  if (method === 'notifications/initialized') { if (lifecycle === 'initialized') lifecycle = 'ready'; return }
  if (id == null) return
  if (method === 'ping') { send(result(id, {})); return }
  if (method === 'initialize') {
    if (lifecycle !== 'idle') { send(rpcError(id, -32600, 'already_initialized')); return }
    const clientName = params.clientInfo?.name || '-'
    if (allowedClients.size && !allowedClients.has(clientName)) { send(rpcError(id, -32000, 'client_not_allowed')); return }
    lifecycle = 'initialized'
    send(result(id, { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'memoria-kota2-mcp', version: '2.0.0' } }))
    return
  }
  if (lifecycle !== 'ready') { send(rpcError(id, -32002, 'server_not_initialized')); return }
  if (method === 'tools/list') { send(result(id, { tools })); return }
  if (method === 'tools/call') {
    try {
      const value = await dispatch(params.name, params.arguments || {})
      send(result(id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }))
    } catch (error) {
      send(result(id, { content: [{ type: 'text', text: JSON.stringify({ error_code: error.message || 'internal_error' }) }], isError: true }))
    }
    return
  }
  send(rpcError(id, -32601, 'method_not_found'))
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) if (line.trim()) await handle(line)
