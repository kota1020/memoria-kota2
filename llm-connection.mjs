#!/usr/bin/env node
// Connection doctor/repair used by the terminal launch guard.

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const home = process.env.MEMORIA_USER_HOME || homedir()
const memoriaHome = process.env.MEMORIA_HOME || path.join(home, 'Library/Application Support/Memoria')
const mcpPath = path.join(memoriaHome, 'bin/memoria-mcp')
const consentPath = path.join(memoriaHome, 'mcp.json')
const allScopes = ['task_metadata', 'working_content', 'deliverable_content', 'activity_content', 'memory_write']
const requiredReadTools = ['memoria_health', 'get_current_context', 'recall_memory', 'get_current_activity']
const requiredWriteTools = ['save_memory', 'record_judgment', 'close_judgment']
const providers = {
  codex: { profile: 'codex', clients: ['codex', 'Codex', 'codex-mcp-client'], binary: 'codex' },
  claude: { profile: 'claude-code', clients: ['Claude Code', 'claude-code', 'claude'], binary: 'claude' },
  kimi: { profile: 'kimi', clients: ['kimi-code', 'Kimi Code', 'kimi'], binary: 'kimi' },
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, ...options })
}
function executable(command) { return run('/usr/bin/which', [command]).status === 0 }
function readJSON(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
function readJSONForWrite(file, missingValue) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(missingValue)
    throw new Error(`invalid_json:${file}`)
  }
}
function atomicJSON(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}
function authorizeProfile(name) {
  const spec = providers[name]
  const consent = readJSONForWrite(consentPath, { version: 'mcp_consent_v1', enabled: true, remote_enabled: false, profiles: [] })
  if (consent.enabled === false) throw new Error('memoria_consent_disabled')
  consent.enabled = true
  consent.remote_enabled ??= false
  consent.version ||= 'mcp_consent_v1'
  consent.profiles ||= []
  const current = consent.profiles.find(profile => profile.profile_id === spec.profile)
  if (current?.enabled === false) throw new Error(`profile_disabled:${spec.profile}`)
  const next = {
    ...(current || {}), profile_id: spec.profile, enabled: true,
    allowed_client_names: [...new Set([...(current?.allowed_client_names || []), ...spec.clients])],
    scopes: [...new Set([...(current?.scopes || []), ...allScopes])], max_content_bytes: 65536,
  }
  if (current) consent.profiles[consent.profiles.indexOf(current)] = next
  else consent.profiles.push(next)
  atomicJSON(consentPath, consent)
}
function requireAuthorizedProfile(name) {
  const spec = providers[name]
  const consent = readJSONForWrite(consentPath, null)
  const profile = consent?.enabled && consent.profiles?.find(item => item.profile_id === spec.profile && item.enabled && item.surface !== 'remote')
  if (!profile) throw new Error(`profile_not_authorized:${spec.profile}`)
}
function registration(name) {
  if (name === 'codex') {
    const value = run('codex', ['mcp', 'get', 'memoria'])
    return value.status === 0 && `${value.stdout}${value.stderr}`.includes(mcpPath)
  }
  if (name === 'claude') {
    const value = run('claude', ['mcp', 'get', 'memoria'])
    return value.status === 0 && `${value.stdout}${value.stderr}`.includes(mcpPath)
  }
  const config = readJSON(path.join(home, '.kimi-code/mcp.json'), {})
  return config.mcpServers?.memoria?.command === mcpPath
}
function requiredTools(name) {
  const spec = providers[name]
  const consent = readJSON(consentPath, {})
  const profile = consent.profiles?.find(item => item.profile_id === spec.profile && item.enabled !== false)
  return profile?.scopes?.includes('memory_write') ? [...requiredReadTools, ...requiredWriteTools] : requiredReadTools
}
function probe(name) {
  if (!existsSync(mcpPath)) return { ok: false, reason: 'mcp_binary_missing' }
  const spec = providers[name]
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: spec.clients[0], version: 'launch-guard' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memoria_health', arguments: {} } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
  const value = run(mcpPath, ['--profile', spec.profile], { input: messages })
  if (value.status !== 0) return { ok: false, reason: (value.stderr || 'mcp_probe_failed').trim().slice(0, 200) }
  const lines = value.stdout.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const initialized = lines.find(line => line.id === 1)
  const serverInfo = initialized?.result?.serverInfo
  const serverMajor = Number.parseInt(String(serverInfo?.version || '').split('.')[0], 10)
  if (serverInfo?.name !== 'memoria-kota2-mcp' || !Number.isInteger(serverMajor) || serverMajor < 2) {
    return { ok: false, reason: 'mcp_server_contract_mismatch' }
  }
  const listed = lines.find(line => line.id === 2)
  if (!Array.isArray(listed?.result?.tools)) return { ok: false, reason: 'mcp_tools_list_failed' }
  const available = new Set(listed.result.tools.map(tool => tool?.name).filter(Boolean))
  const missing = requiredTools(name).filter(tool => !available.has(tool))
  if (missing.length) return { ok: false, reason: `mcp_tool_contract_mismatch:${missing.join(',')}` }
  const call = lines.find(line => line.id === 3)
  if (call?.result?.isError === false) {
    try {
      const payload = JSON.parse(call.result.content?.[0]?.text || '{}')
      if (payload.ok === true) return { ok: true }
      return { ok: false, reason: 'live_data_not_ready' }
    } catch {}
  }
  return { ok: false, reason: call?.error?.message || 'mcp_health_failed' }
}
function status(name) {
  if (!providers[name]) return { provider: name, installed: false, connected: false, reason: 'unsupported_provider' }
  if (!executable(providers[name].binary)) return { provider: name, installed: false, connected: false, reason: 'not_installed' }
  const registered = registration(name)
  if (!registered) return { provider: name, installed: true, registered: false, connected: false, reason: 'not_registered' }
  const checked = probe(name)
  return { provider: name, installed: true, registered: true, connected: checked.ok, reason: checked.reason || null }
}
function repairMemoriaService() {
  if (typeof process.getuid !== 'function') return
  run('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/com.memoria.kota2.api`])
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = run('/usr/bin/curl', ['-fsS', '--max-time', '1', 'http://127.0.0.1:4319/health'])
    if (response.status === 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
}
function connect(name) {
  const spec = providers[name]
  if (!spec || !executable(spec.binary)) return { provider: name, ok: false, reason: 'not_installed' }
  if (!existsSync(mcpPath)) return { provider: name, ok: false, reason: 'mcp_binary_missing' }
  try { requireAuthorizedProfile(name) } catch (error) { return { provider: name, ok: false, reason: error.message } }
  if (!registration(name)) {
    let value
    if (name === 'codex') value = run('codex', ['mcp', 'add', 'memoria', '--', mcpPath, '--profile', spec.profile])
    else if (name === 'claude') value = run('claude', ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'memoria', '--', mcpPath, '--profile', spec.profile])
    else {
      const file = path.join(home, '.kimi-code/mcp.json')
      let config
      try { config = readJSONForWrite(file, { mcpServers: {} }) } catch (error) { return { provider: name, ok: false, reason: error.message } }
      config.mcpServers ||= {}
      if (config.mcpServers.memoria && config.mcpServers.memoria.command !== mcpPath) return { provider: name, ok: false, reason: 'foreign_memoria_entry' }
      config.mcpServers.memoria = { command: mcpPath, args: ['--profile', spec.profile] }
      atomicJSON(file, config)
      value = { status: 0, stderr: '' }
    }
    if (value.status !== 0) return { provider: name, ok: false, reason: (value.stderr || value.stdout || 'registration_failed').trim().slice(0, 300) }
  }
  let checked = status(name)
  if (checked.registered && !checked.connected && checked.reason === 'live_data_not_ready') {
    repairMemoriaService()
    checked = status(name)
  }
  return { provider: name, ok: checked.connected, reason: checked.reason }
}
function authorize(name) {
  const spec = providers[name]
  if (!spec || !executable(spec.binary)) return { provider: name, ok: false, reason: 'not_installed' }
  try { authorizeProfile(name) } catch (error) { return { provider: name, ok: false, reason: error.message } }
  return connect(name)
}
function installedProviders() { return Object.keys(providers).filter(name => executable(providers[name].binary)) }
function targets(value) { return value === 'herdr' || value === 'all' ? installedProviders() : [value] }
function escapeAppleScript(value) { return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') }
function prompt(target) {
  const names = targets(target)
  const missing = process.env.MEMORIA_GUARD_FORCE_DISCONNECTED === '1'
    ? names.map(name => ({ provider: name, installed: true, connected: false, reason: 'forced_test' }))
    : names.map(status).filter(item => item.installed && !item.connected)
  if (!missing.length) return { ok: true, prompted: false, providers: names }
  const guardLock = path.join(memoriaHome, 'llm-connection-prompt.lock')
  try { mkdirSync(guardLock, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') {
      try {
        if (Date.now() - statSync(guardLock).mtimeMs > 120_000) {
          rmdirSync(guardLock)
          mkdirSync(guardLock, { mode: 0o700 })
        } else return { ok: false, prompted: false, reason: 'prompt_already_open' }
      } catch { return { ok: false, prompted: false, reason: 'prompt_lock_unavailable' } }
    }
    else throw error
  }
  try {
    let choice = process.env.MEMORIA_GUARD_CHOICE
    if (!choice) {
      const label = missing.map(item => item.provider).join(' / ')
      const message = `Memoriaが${label}に接続されていません。接続しますか？`
      const script = `button returned of (display dialog "${escapeAppleScript(message)}" with title "Memoria 接続" buttons {"いいえ", "はい"} default button "はい" cancel button "いいえ" with icon caution)`
      const value = run('/usr/bin/osascript', ['-e', script], { timeout: 120_000 })
      choice = value.status === 0 && value.stdout.includes('はい') ? 'yes' : 'no'
    }
    if (choice !== 'yes') return { ok: false, prompted: true, connected: false, providers: missing.map(item => item.provider) }
    const results = missing.map(item => connect(item.provider))
    const ok = results.every(result => result.ok)
    if (!process.env.MEMORIA_GUARD_CHOICE) {
      const body = ok ? 'Memoriaへ接続しました。次の新規セッションからMCPが使えます。' : `接続できませんでした: ${results.filter(result => !result.ok).map(result => `${result.provider} (${result.reason})`).join(', ')}`
      run('/usr/bin/osascript', ['-e', `display notification "${escapeAppleScript(body)}" with title "Memoria"`])
    }
    return { ok, prompted: true, connected: ok, results }
  } finally {
    try { rmdirSync(guardLock) } catch {}
  }
}

const [command = 'status', target = 'all'] = process.argv.slice(2)
let output
if (command === 'status') output = targets(target).map(status)
else if (command === 'probe') output = targets(target).map(name => ({ provider: name, ...probe(name) }))
else if (command === 'connect') output = targets(target).map(connect)
else if (command === 'authorize') output = targets(target).map(authorize)
else if (command === 'prompt') output = prompt(target)
else { process.stderr.write('usage: llm-connection.mjs status|probe|connect|authorize|prompt <codex|claude|kimi|herdr|all>\n'); process.exit(2) }
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
if ((command === 'probe' || command === 'connect' || command === 'authorize') && output.some(item => !item.ok)) process.exitCode = 1
