import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDeadline, normalizeFacts, mergeFacts, renderFactsSection, factsFor } from '../parser/facts.mjs'
import { enforceGrounding } from '../parser/grounding.mjs'

const base = '2026-07-29T05:00:00.000Z'  // JST 7/29 14:00

test('parseDeadline: 月日だけなら基準日に近い年へ補う', () => {
  assert.equal(parseDeadline('7/31', base), '2026-07-31')
  assert.equal(parseDeadline('7月31日', base), '2026-07-31')
  assert.equal(parseDeadline('2026-08-15', base), '2026-08-15')
  assert.equal(parseDeadline('1/15', '2026-12-20T05:00:00Z'), '2027-01-15')
  assert.equal(parseDeadline('来週中', base), null)
})

test('normalizeFacts: 型外・空・日付に落ちない締切は落とす。同一は1件', () => {
  const out = normalizeFacts([
    { type: 'person', value: '田中さん', detail: '相手', task_id: 't1', evidence: '田中さん 13:58 締切7/31でお願いします' },
    { type: 'person', value: '田中さん', evidence: 'x' },
    { type: 'deadline', value: '締切7/31', detail: 'プロジェクトA', when: '7/31', evidence: '締切7/31でお願いします' },
    { type: 'deadline', value: 'なるはやで', evidence: 'なるはやで' },
    { type: 'hobby', value: 'x', evidence: 'x' },
    { type: 'project', value: '', evidence: 'x' },
  ], { baseISO: base })
  assert.deepEqual(out.map(f => f.key), ['person:田中さん', 'deadline:2026-07-31:プロジェクトa'])
  assert.equal(out[1].when, '2026-07-31')
})

test('mergeFacts: 同keyは回数を増やし、過ぎて久しい締切は忘れる', () => {
  const a = normalizeFacts([{ type: 'person', value: '田中さん', evidence: 'e' }], { baseISO: base })
  let live = mergeFacts({ facts: [] }, a, '2026-07-29T05:00:00Z')
  live = mergeFacts(live, a, '2026-07-29T06:00:00Z')
  assert.equal(live.facts.length, 1)
  assert.equal(live.facts[0].count, 2)
  const old = normalizeFacts([{ type: 'deadline', value: '3/1', when: '2026-03-01', evidence: 'e' }], { baseISO: base })
  live = mergeFacts(live, old, '2026-07-29T06:00:00Z')  // now(実時刻)から30日以上前 → 落ちる
  assert.ok(!live.facts.some(f => f.type === 'deadline'))
})

test('renderFactsSection / factsFor: 未来の締切と質問語に当たる人を返す', () => {
  const now = Date.parse(base)
  const facts = normalizeFacts([
    { type: 'person', value: '田中さん', detail: '相手', evidence: 'e' },
    { type: 'deadline', value: '7/31', detail: 'プロジェクトA', evidence: 'e' },
    { type: 'decision', value: '口頭承認OK', detail: 'Meet 13:42', evidence: 'e' },
    { type: 'project', value: 'プロジェクトA', evidence: 'e' },
  ], { baseISO: base })
  const live = mergeFacts({ facts: [] }, facts, base)
  const md = renderFactsSection(live, { nowMs: now })
  assert.match(md, /締切 2026-07-31：プロジェクトA/)
  assert.match(md, /人 田中さん：相手/)
  const hits = factsFor('例の件、プロジェクトAどうなってたっけ', live, { nowMs: now })
  assert.ok(hits.some(f => f.type === 'project'))
  assert.ok(hits.some(f => f.type === 'deadline'))
  assert.ok(factsFor('田中', live, { nowMs: now })[0].value === '田中さん')
})

test('grounding: ログに無い人名・締切は発明とみなして落とす', () => {
  const log = '2026-07-29 13:58 モニタ=Slack「#プロジェクトA」 :: 田中さん 13:58 締切7/31でお願いします！'
  const r = enforceGrounding({ open_tasks: [], closed_tasks: [], facts: [
    { type: 'person', value: '田中さん', evidence: '田中さん 13:58 締切7/31でお願いします' },
    { type: 'person', value: '佐藤部長', evidence: '佐藤部長から承認をもらった' },
  ] }, log)
  assert.deepEqual(r.facts.map(f => f.value), ['田中さん'])
  assert.equal(r.dropped[0].bucket, 'fact')
})
