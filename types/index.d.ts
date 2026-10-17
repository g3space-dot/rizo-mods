export type BridgeLog = { at: number; text: string; kind: 'in' | 'out' | 'info' | 'warn' }

export type BridgeState = {
  /** 브리지가 이 세션에서 켜져 있는지 */
  on: boolean
  /** 상황판 DB를 읽고 쓰는 도구 이름 (없으면 null) */
  tool: string | null
  /** 마지막 확인 때 대기 중이던 명령 수 */
  queued: number
  /** 마지막 확인 시각 (epoch ms) */
  lastPoll: number
  /** 이 세션이 상황판에 마지막으로 쓴 상태 */
  status: 'idle' | 'working' | 'done' | 'blocked'
  /** 현재 작업 제목 (프롬프트 첫 줄) */
  task: string
  /** 최근 기록 */
  log: BridgeLog[]
}

declare module 'claude-code' {
  interface PluginState {
    'control-bridge': { bridge: BridgeState }
  }
}
