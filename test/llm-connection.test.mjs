import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = path.resolve('llm-connection.mjs')

function fixture() {
  return mkdtempSync(path.join(tmpdir(), 'memoria-connection-test-'))
}

function run(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: path.dirname(script), encoding: 'utf8',
    env: { ...process.env, MEMORIA_HOME: home, MEMORIA_USER_HOME: home, ...extraEnv },
  })
}

function fakeMcp(home, { tools, serverName = 'memoria-kota2-mcp', version = '2.0.0', health = true }) {
  const bin = path.join(home, 'bin/memoria-mcp')
  mkdirSync(path.dirname(bin), { recursive: true })
  const responses = [
    { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: serverName, version } } },
    { jsonrpc: '2.0', id: 2, result: { tools: tools.map(name => ({ name })) } },
    { jsonrpc: '2.0', id: 3, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: health }) }] } },
  ]
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on('end', () => process.stdout.write(${JSON.stringify(responses.map(item => JSON.stringify(item)).join('\n') + '\n')}))\n`, { mode: 0o700 })
}

test('authorize refuses to overwrite malformed consent JSON', () => {
  const home = fixture()
  const file = path.join(home, 'mcp.json')
  writeFileSync(file, '{broken-json\n', { mode: 0o600 })
  try {
    const result = run(home, ['authorize', 'codex'])
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /invalid_json:/)
    assert.equal(readFileSync(file, 'utf8'), '{broken-json\n')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('connect refuses to overwrite malformed Kimi MCP JSON', () => {
  const home = fixture()
  const memoriaHome = path.join(home, 'memoria-home')
  const kimiFile = path.join(home, '.kimi-code/mcp.json')
  mkdirSync(path.dirname(kimiFile), { recursive: true })
  mkdirSync(path.join(memoriaHome, 'bin'), { recursive: true })
  writeFileSync(path.join(memoriaHome, 'bin/memoria-mcp'), '#!/bin/sh\n', { mode: 0o700 })
  writeFileSync(path.join(memoriaHome, 'mcp.json'), JSON.stringify({
    version: 'mcp_consent_v1', enabled: true,
    profiles: [{ profile_id: 'kimi', enabled: true, scopes: ['task_metadata'] }],
  }))
  writeFileSync(kimiFile, '{broken-kimi-json\n', { mode: 0o600 })
  try {
    const result = run(memoriaHome, ['connect', 'kimi'], { MEMORIA_USER_HOME: home })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /invalid_json:/)
    assert.equal(readFileSync(kimiFile, 'utf8'), '{broken-kimi-json\n')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('No is fail-open and releases the prompt lock', () => {
  const home = fixture()
  try {
    const result = run(home, ['prompt', 'codex'], {
      MEMORIA_GUARD_FORCE_DISCONNECTED: '1', MEMORIA_GUARD_CHOICE: 'no',
    })
    assert.equal(result.status, 0)
    const output = JSON.parse(result.stdout)
    assert.equal(output.prompted, true)
    assert.equal(output.connected, false)
    assert.equal(existsSync(path.join(home, 'llm-connection-prompt.lock')), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('a stale popup lock is recovered', () => {
  const home = fixture()
  const lock = path.join(home, 'llm-connection-prompt.lock')
  mkdirSync(lock)
  const old = new Date(Date.now() - 180_000)
  utimesSync(lock, old, old)
  try {
    const result = run(home, ['prompt', 'codex'], {
      MEMORIA_GUARD_FORCE_DISCONNECTED: '1', MEMORIA_GUARD_CHOICE: 'no',
    })
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).prompted, true)
    assert.equal(existsSync(lock), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('probe accepts the current Memoria server and required read contract', () => {
  const home = fixture()
  fakeMcp(home, { tools: ['memoria_health', 'get_current_context', 'recall_memory', 'get_current_activity'] })
  try {
    const result = run(home, ['probe', 'codex'])
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout)[0].ok, true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('probe rejects an old or incomplete Memoria tool contract', () => {
  const home = fixture()
  fakeMcp(home, { tools: ['memoria_health', 'get_current_context', 'get_current_activity'] })
  try {
    const result = run(home, ['probe', 'codex'])
    assert.notEqual(result.status, 0)
    assert.match(JSON.parse(result.stdout)[0].reason, /^mcp_tool_contract_mismatch:recall_memory$/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
