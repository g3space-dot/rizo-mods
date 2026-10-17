import { expect, mock, test } from 'claude-code/testing'

const URL = 'https://claude.ai/artifact/BKLTCxuxhLFxAHE9p5qsNq'

// 상황판 DB 도구를 흉내 내는 바닥: tool.list 에 ArtifactData 를 올리고,
// query 에 대기 명령 한 건을 답하고, update/set 은 기록만 한다.
function fakeDb(on: any, writes: any[]) {
  const queued = { id: 'CMD-1', version: 3, data: { kind: 'poke', agent: 'rizo-claude', ai: 'rizo-claude', taskId: 'T-20261016-15', message: '주간 매출 보고 진행 상황 확인', status: 'queued' } }
  on('tool.list', async () => ({ value: [{ name: 'ArtifactData', description: 'dashboard db' }] }))
  on('tool.call', { tool: 'ArtifactData' }, async (_$: any, e: any) => {
    if (e.action === 'query') {
      const text = `1 documents from collection "commands":\n=== BEGIN ===\n${JSON.stringify(queued)}\n=== END ===`
      return { result: { text }, text }
    }
    writes.push({ action: e.action, collection: e.collection, doc_id: e.doc_id, data: e.data, if_version: e.if_version })
    return { result: { ok: true }, text: 'ok' }
  })
}

test('켜면 대기열의 내 명령을 선점하고 세션에 제출한다', { options: { autoOn: true, agentId: 'rizo-claude', pollSec: 3, dashboardUrl: URL } }, async ($: any, on: any) => {
  const clock = mock.clock(on)
  const writes: any[] = []
  const submitted: string[] = []
  fakeDb(on, writes)
  on('prompt.submit', async (_$: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('command.register', async () => ({ value: { command: 'bridge' } }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))

  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await clock.advance(3_500)

  // 선점 기록: commands/CMD-1 을 version 3 핀으로 running 으로
  const claim = writes.find(w => w.collection === 'commands' && w.doc_id === 'CMD-1')
  expect(claim).toBeTruthy()
  expect(claim.data.status).toBe('running')
  expect(claim.if_version).toBe(3)
  // 세션에 제출된 프롬프트에 메시지와 명령 id가 들어 있다
  expect(submitted.length).toBeGreaterThan(0)
  expect(submitted[0]).toContain('주간 매출 보고 진행 상황 확인')
  expect(submitted[0]).toContain('CMD-1')
})

test('DB 도구가 없는 세션에서는 아무것도 쓰지 않는다', { options: { autoOn: true } }, async ($: any, on: any) => {
  const clock = mock.clock(on)
  const calls: any[] = []
  on('tool.call', async (_$: any, e: any, next: any) => { calls.push(e.tool); return next(e) })
  on('tool.list', async () => ({ value: [] }))
  on('command.register', async () => ({ value: { command: 'bridge' } }))
  on('ui.status', async () => ({ value: undefined }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)
  expect(calls.filter(t => t === 'ArtifactData').length).toBe(0)
})
