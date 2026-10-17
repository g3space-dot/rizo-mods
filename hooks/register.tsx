import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BridgeLog, BridgeState } from '../types'

/*
 * 관제 브리지 — AI 관제 사무실 상황판(아티팩트 DB) ⇄ 이 Claude 세션
 *
 *  들어오는 길: 상황판에서 승인·재촉을 누르면 DB `commands`에 status 'queued'로 쌓인다.
 *               브리지가 켜진 세션이 몇 초마다 그 대기열을 읽어, 자기 몫(agent/ai가 이 세션의 agentId)을
 *               'running'으로 잡고(if_version 핀 → 세션 여럿이 켜져 있어도 하나만 가져감)
 *               그 message를 이 대화에 프롬프트로 제출한다. 끝나면 'done'으로 적는다.
 *  나가는 길:   이 세션에서 프롬프트가 들어오면 agents/<agentId>를 working(+작업 제목)으로,
 *               턴이 끝나면 done→idle로 상황판에 쓴다. 사무실 캐릭터가 초 단위로 반응한다.
 *
 *  DB 접근은 이 세션에 있는 상황판 데이터 도구(ArtifactData 또는 artifacts_data 계열 MCP 도구)로 한다.
 *  그런 도구가 없는 세션에서는 아무것도 쓰지 않고 패널에 그 사실만 보인다.
 */

const PLUGIN = 'control-bridge'
/** 이 PC에 저장된 에이전트 id(/bridge as <id>)가 설정값보다 우선 */
async function whoAmI($: any, opts: any): Promise<string> { try { const v = await $.store.get('agentId'); if (typeof v === 'string' && v.trim()) return v.trim() } catch {} return String(opts.agentId) }
const PANE = 'control-bridge'
const state = atom({ plugin: 'control-bridge', key: 'bridge' } as const, {
  on: false, tool: null, queued: 0, lastPoll: 0, status: 'idle', task: '', log: [],
} as BridgeState)

type Cmd = { id: string; version: number; data: Record<string, any> }

const nowMs = () => Date.now()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

async function log($: any, kind: BridgeLog['kind'], text: string) {
  await update($, state, s => ({ ...s, log: [...s.log, { at: nowMs(), kind, text }].slice(-40) }))
}

/* ---------- 상황판 DB 도구 찾기 ---------- */
async function findDbTool($: any): Promise<string | null> {
  const tools = await $.tool.list()
  const names: string[] = tools.map((t: any) => t.name)
  const exact = names.find(n => n === 'ArtifactData')
  if (exact) return exact
  const mcp = names.find(n => /artifact/i.test(n) && /data/i.test(n) && /mcp__/.test(n))
  return mcp ?? null
}

/** 도구 결과 텍스트에서 문서 줄(JSON 한 줄씩)을 꺼낸다. */
function parseDocs(text: string): Cmd[] {
  const out: Cmd[] = []
  for (const line of String(text || '').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o.id === 'string' && o.data) out.push({ id: o.id, version: Number(o.version) || 0, data: o.data })
    } catch { /* 문서 줄이 아님 */ }
  }
  return out
}

async function dbQuery($: any, tool: string, url: string, collection: string, where: any[][]) {
  const r = await $.tool.call({ tool, action: 'query', url, collection, query: { where, limit: 50 } })
  if (r.deny !== undefined || r.isError) throw new Error(r.deny ?? r.text ?? 'query failed')
  return parseDocs(r.text ?? '')
}
/** 문서 하나와 그 version. 없으면 null. (이미 있는 문서에 쓰려면 version 핀이 필수) */
async function dbGet($: any, tool: string, url: string, collection: string, doc_id: string): Promise<Cmd | null> {
  const r = await $.tool.call({ tool, action: 'get', url, collection, doc_id })
  if (r.deny !== undefined || r.isError) return null
  return parseDocs(r.text ?? '')[0] ?? null
}
async function dbUpdate($: any, tool: string, url: string, collection: string, doc_id: string, data: any, if_version?: number) {
  const input: any = { tool, action: 'update', url, collection, doc_id, data }
  const v = if_version ?? (await dbGet($, tool, url, collection, doc_id))?.version
  if (v) input.if_version = v
  const r = await $.tool.call(input)
  if (r.deny !== undefined || r.isError) throw new Error(r.deny ?? r.text ?? 'update failed')
  return r
}
/** 있으면 version 핀으로 update, 없으면 새로 set */
async function dbSet($: any, tool: string, url: string, collection: string, doc_id: string, data: any) {
  const cur = await dbGet($, tool, url, collection, doc_id)
  const input: any = cur ? { tool, action: 'update', url, collection, doc_id, data, if_version: cur.version } : { tool, action: 'set', url, collection, doc_id, data }
  const r = await $.tool.call(input)
  if (r.deny !== undefined || r.isError) throw new Error(r.deny ?? r.text ?? 'set failed')
  return r
}

/* ---------- 이 세션의 상태를 상황판에 쓰기 ---------- */
async function pushAgent($: any, opts: any, status: BridgeState['status'], task: string, note: string) {
  const s = await read($, state)
  if (!s.on || !s.tool) return
  try {
    await dbSet($, s.tool, String(opts.dashboardUrl), 'agents', await whoAmI($, opts), { status, task, note })
    await update($, state, x => ({ ...x, status, task }))
  } catch (err: any) {
    await log($, 'warn', `상태 쓰기 실패: ${clip(String(err?.message ?? err), 60)}`)
  }
}

/* ---------- 대기열 한 바퀴 ---------- */
async function pollOnce($: any, opts: any) {
  const s = await read($, state)
  if (!s.on || !s.tool) return
  const url = String(opts.dashboardUrl)
  const me = await whoAmI($, opts)
  let cmds: Cmd[] = []
  try {
    cmds = await dbQuery($, s.tool, url, 'commands', [['status', '==', 'queued']])
  } catch (err: any) {
    await log($, 'warn', `대기열 읽기 실패: ${clip(String(err?.message ?? err), 60)}`)
    return
  }
  // 내 몫만: agent 또는 ai 가 이 세션의 id 이거나, 결재(kind 없음)이면서 ai 가 나인 것
  const mine = cmds.filter(c => c.data.agent === me || c.data.ai === me || (!c.data.kind && c.data.ai === me))
  await update($, state, x => ({ ...x, queued: mine.length, lastPoll: nowMs() }))
  $.ui.status(mine.length ? `관제 브리지 · 대기 ${mine.length}` : `관제 브리지 ON`)
  for (const c of mine.slice(0, 3)) {
    // 선점: 같은 명령을 다른 세션·실행기가 잡았으면 if_version 이 어긋나 실패한다 → 건너뜀
    try {
      await dbUpdate($, s.tool, url, 'commands', c.id, { status: 'running', by: 'bridge:' + me, startedAt: new Date().toISOString() }, c.version)
    } catch { continue }
    const d = c.data
    const head = d.kind === 'poke' ? '[상황판 재촉]' : d.kind === 'rest' ? '[상황판 휴식]' : `[상황판 결재 · ${d.decision ?? ''}]`
    const text = `${head} ${d.taskId ? d.taskId + ' · ' : ''}${String(d.message ?? '').trim()}${d.reply ? `\n대표 메모: ${d.reply}` : ''}\n(명령 ${c.id}. 끝나면 결과를 한 줄로 알려줘. 되돌릴 수 없는 일은 이 메시지에 분명히 적혀 있을 때만 해.)`
    await log($, 'in', `${c.id} → 세션에 제출 (${clip(String(d.message ?? ''), 40)})`)
    $.ui.toast(`관제 브리지: ${clip(String(d.message ?? c.id), 50)}`)
    // 프롬프트는 세션이 한가해지면 자기 턴으로 돈다. 그 턴의 끝(turn.complete)에서 done 으로 닫는다.
    pending.push({ id: c.id, reqId: d.reqId ?? null, agent: d.agent ?? me })
    void $.prompt.submit({ text, asUser: true })
  }
}

/** 세션에 제출했지만 아직 끝나지 않은 명령들 (모듈 변수: 리로드되면 비워진다 → 그 경우 running 으로 남고 실행기가 수습) */
const pending: { id: string; reqId: string | null; agent: string }[] = []

async function closePending($: any, opts: any, resultText: string) {
  const s = await read($, state)
  if (!s.tool || !pending.length) return
  const url = String(opts.dashboardUrl)
  const done = pending.splice(0, pending.length)
  for (const p of done) {
    try {
      await dbUpdate($, s.tool, url, 'commands', p.id, { status: 'done', result: clip(resultText, 200), finishedAt: new Date().toISOString() })
      if (p.reqId) await dbUpdate($, s.tool, url, 'requests', p.reqId, { applied: true, appliedAt: new Date().toISOString(), execResult: clip(resultText, 200) })
      const eid = 'E-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12) + '-' + Math.random().toString(36).slice(2, 5)
      await dbSet($, s.tool, url, 'events', eid, { type: 'done', agent: p.agent, text: clip('브리지 처리: ' + resultText, 18), at: new Date().toISOString() })
      await log($, 'out', `${p.id} 완료 기록`)
    } catch (err: any) {
      await log($, 'warn', `${p.id} 완료 기록 실패: ${clip(String(err?.message ?? err), 50)}`)
    }
  }
}

/* ---------- 켜기 / 끄기 ---------- */
let ticker: { cancel: () => void } | null = null
async function setOn($: any, opts: any, on: boolean) {
  const tool = on ? await findDbTool($) : null
  const me = await whoAmI($, opts)
  await update($, state, s => ({ ...s, on, tool, me }))
  if (ticker) { ticker.cancel(); ticker = null }
  if (on) {
    if (!tool) {
      await log($, 'warn', '이 세션에는 상황판 DB 도구(ArtifactData)가 없어 읽고 쓸 수 없습니다')
      $.ui.status('관제 브리지 · DB 도구 없음')
      return
    }
    const ms = Math.max(3, Number(opts.pollSec) || 6) * 1000
    ticker = $.clock.every(ms, () => { void pollOnce($, opts) })
    await log($, 'info', `켜짐 · ${tool} · ${ms / 1000}초마다 확인 · 나는 ${await whoAmI($, opts)}`)
    $.ui.status('관제 브리지 ON')
    void pollOnce($, opts)
  } else {
    await log($, 'info', '꺼짐')
    $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  const opts = options as any

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'bridge', description: '관제 브리지: on | off | sync | as <에이전트id> — 상황판과 이 세션을 잇는다' })
    if (opts.autoOn) await setOn($, opts, true)
    return next(e)
  })

  on('command.run', { command: 'bridge' }, async ($, e) => {
    const arg = String((e as any).args ?? (e as any).text ?? '').trim().toLowerCase()
    if (arg === 'on' || arg === '켜기') { await setOn($, opts, true); return { text: '관제 브리지를 켰습니다. 상황판의 결재·재촉이 이 세션으로 바로 들어옵니다.' } }
    if (arg === 'off' || arg === '끄기') { await setOn($, opts, false); return { text: '관제 브리지를 껐습니다.' } }
    if (arg === 'sync' || arg === '동기화') { await pollOnce($, opts); return { text: '대기열을 지금 확인했습니다.' } }
    if (arg.startsWith('as ') || arg.startsWith('나는 ')) { const id = arg.split(/\s+/)[1] ?? ''; if (!/^[a-z0-9-]+$/.test(id)) return { text: '형식: /bridge as rizo-rog  (영문 소문자·숫자·하이픈)' }
      await $.store.set('agentId', id); const s0 = await read($, state); if (s0.on) await setOn($, opts, true)
      return { text: `이 PC의 에이전트 id를 ${id} 로 저장했습니다. (설정값보다 우선, /bridge as 로 다시 바꿀 수 있음)` } }
    await $.ui.open({ id: PANE, title: '관제 브리지' })
    const s = await read($, state)
    return { text: `관제 브리지 ${s.on ? 'ON' : 'OFF'} · 나는 ${await whoAmI($, opts)} · 도구 ${s.tool ?? '없음'} · 대기 ${s.queued}. 명령: /bridge on | off | sync | as <id>` }
  })

  // 들어오는 프롬프트 → 상황판에 "작업 중"
  on('prompt.submit', async ($, e, next) => {
    const s = await read($, state)
    if (s.on && s.tool) {
      const first = String(e.text ?? '').split('\n')[0] ?? ''
      void pushAgent($, opts, 'working', clip(first, 40), '세션 진행 중 (브리지)')
    }
    return next(e)
  }).catch(($, e, next) => next(e))   // 브리지가 실패해도 프롬프트는 막지 않는다

  // 턴 종료 → 완료 표시 후 잠시 뒤 대기, 제출했던 명령은 done 으로
  on('turn.complete', async ($, e, next) => {
    const s = await read($, state)
    if (s.on && s.tool) {
      const summary = String((e as any).text ?? '').split('\n').find(l => l.trim()) ?? '턴 완료'
      await closePending($, opts, summary)
      void pushAgent($, opts, 'done', s.task, clip(summary, 60))
      $.clock.after(90_000, () => { void pushAgent($, opts, 'idle', s.task, '') })
    }
    return next(e)
  })

  // 패널
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e) as any
    const s = await read($, state)
    const room = Math.max(3, (e.viewport?.rows ?? 20) - 8)
    const fmt = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
    return (
      <Box flexDirection="column">
        <Text bold>관제 브리지 {s.on ? '● ON' : '○ OFF'}</Text>
        <Text dimColor>나: {s.me ?? String(opts.agentId)} · DB 도구: {s.tool ?? '없음'} · 대기 {s.queued}{s.lastPoll ? ` · 확인 ${fmt(s.lastPoll)}` : ''}</Text>
        <Text dimColor>세션 상태 → 상황판: {s.status}{s.task ? ` · ${s.task}` : ''}</Text>
        <Box flexDirection="row" gap={1}>
          <Button onPress={async () => { await setOn($, opts, !s.on) }}>{s.on ? '끄기' : '켜기'}</Button>
          <Button onPress={async () => { await pollOnce($, opts) }}>지금 확인</Button>
          <Link href={String(opts.dashboardUrl)}>상황판 열기</Link>
        </Box>
        <Text> </Text>
        {s.log.length === 0 && <Text dimColor>아직 기록 없음. /bridge on 으로 켭니다.</Text>}
        {s.log.slice(-room).map(l => (
          <Text dimColor={l.kind === 'info'} color={l.kind === 'warn' ? 'yellow' : l.kind === 'in' ? 'green' : undefined}>
            {fmt(l.at)} {l.kind === 'in' ? '←' : l.kind === 'out' ? '→' : l.kind === 'warn' ? '!' : '·'} {l.text}
          </Text>
        ))}
      </Box>
    )
  })
}
