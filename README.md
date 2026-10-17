# control-bridge — AI 관제 사무실 관제 브리지

AI 관제 사무실 상황판(https://claude.ai/artifact/BKLTCxuxhLFxAHE9p5qsNq)과 **지금 열려 있는 Claude 세션**을 잇는 모드입니다.

- 들어오는 길: 상황판에서 승인·재촉을 누르면 DB `commands`에 쌓이고, 브리지가 켜진 세션이 몇 초마다 읽어 **자기 몫을 이 대화에 바로 제출**합니다 (복사·붙여넣기 없음).
- 나가는 길: 이 세션에 프롬프트가 들어오면 상황판의 내 캐릭터가 **작업 중**으로, 턴이 끝나면 **완료 → 대기**로 바뀝니다.
- 세션에 상황판 DB 도구(ArtifactData)가 없는 환경에서는 아무것도 쓰지 않고 패널에 그 사실만 보입니다.

## 설치

### 폴더에서 (이 저장소를 내려받았을 때)
터미널에서:
```
claude plugin marketplace add <이 폴더의 절대 경로>
claude plugin install control-bridge --marketplace rizo-mods
```
데스크톱 앱에서는: 프롬프트 옆 **+** → **Plugins** → **Add marketplace**에 폴더 경로 → **Add plugin**.

### GitHub에서 (저장소로 올린 뒤)
터미널 세션의 프롬프트에:
```
/plugin install control-bridge --marketplace g3space-dot/rizo-mods
```
`y`로 마켓플레이스 추가, 범위는 user 선택.

## 설정 (설치 때 묻거나 /config 에서)
- 상황판 URL — 기본값 그대로
- 내 에이전트 id — 이 세션이 맡는 캐릭터: `rizo-claude` / `susu-claude` / `kei-claude` … (사람마다 다르게)
- 확인 주기(초) — 기본 6
- 자동 켜기 — 켜면 세션이 열릴 때 자동 시작. 끄면 `/bridge on` 으로 켬

## 명령
- `/bridge on` · `/bridge off` · `/bridge sync`(지금 확인) · `/bridge`(패널 열기)
- `/bridge as rizo-rog` — 이 PC의 에이전트 id를 저장 (설정값보다 우선)
