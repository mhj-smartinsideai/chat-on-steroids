# Session Summary — Planner Relay 구현

**Date:** 2026-09-03
**Artifact:** `codex-mhj_26_09_03_01_session_summary.md`
**Workflow:** `$staged-development`, `logging`

---

## 1. 세션 목표

Chat On Steroids의 기존 Chrome extension ↔ local bridge 계약을 재사용해 ChatGPT Plus용 최소 Planner Relay를 구현했다. 허용 operation은 `list_directory`, `read_file`, `search_files`, `write_plan` 네 가지이며, 쓰기 대상은 `C:\Users\mhj\Desktop\mhj_workspace\orca_harness\docs\plans`로 제한했다.

## 2. 진행 경과

| 단계 | 내용 | 결과 |
| --- | --- | --- |
| System Design | 기존 bridge 인증·Origin·body bound와 extension document ownership을 유지하는 Relay 경계 설계 | 승인 후 완료 |
| Macro Blocking | Relay dispatcher, bridge route, background forwarding, content parser/injector, 보안·테스트 블록 정의 | 승인 후 완료 |
| Micro Blocking | request/response allowlist, path containment, size/result bounds, dedupe와 conversation/epoch guard 확정 | 승인 후 완료 |
| Code Implementation | Relay operation과 자동 `<local_tool>` 처리 구현, 회귀 테스트 추가 | 완료 |
| Validation | typecheck, syntax check, build, 관련 suite 및 전체 suite 실행 | 모두 PASS |

## 3. 핵심 결정

| 항목 | 결정 |
| --- | --- |
| Bridge | 새 server를 만들지 않고 기존 authenticated `/planner/relay` POST route를 추가 |
| Root | bridge 요청에서 `rootName`을 받지 않고 승인된 root 중 정확한 canonical target path만 선택 |
| Write scope | `docs/plans` 하위만 허용하고 temporary file + revalidation + atomic rename 사용 |
| Page protocol | 완전한 `<local_tool>...</local_tool>`만 파싱하고 fenced code 및 `<local_tool_result>`는 무시 |
| Safety | unsupported tool, traversal, absolute/UNC path, size 초과, stale conversation/epoch는 fail closed |
| Mutation scope | arbitrary shell, delete, rename, Git mutation을 Relay contract에 포함하지 않음 |

## 4. 검증 실적

| 항목 | 상태 |
| --- | --- |
| `node --check extension/background.js` | PASS |
| `node --check extension/content.js` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test -- --run test/content-script.test.ts -t "Planner Relay page protocol"` | PASS — 2 passed, 278 skipped |
| 관련 4개 suite 실행 | PASS — 4 files, 502 passed |
| 전체 `npm test -- --run` | PASS — 72 files, 1,843 passed, 18 skipped |
| `git diff --check` | PASS |
| 초기 PowerShell `rg ... src/main/planner/*.ts` 진단 명령 | FAIL — wildcard 구문으로 `os error 123`; 이후 디렉터리 대상 명령으로 재실행하여 PASS |
| 실제 Chrome ChatGPT Plus 수동 E2E | NOT RUN — live ChatGPT DOM, extension reload, 실제 target root 연결은 검증하지 않음 |

## 5. 작성·수정한 파일

기준 경로: `C:\Users\mhj\orca\workspaces\chat-on-steroids\arowana`

| 파일 | 설명 | 상태 |
| --- | --- | --- |
| `src/main/planner/codex-mhj_26_09_02_02_security.ts` | Relay용 `docs/plans` write path containment helper 추가 | 유효, 미커밋 |
| `src/main/planner/codex-mhj_26_09_02_07_relay.ts` | 네 operation의 request validation, bounded repository access, atomic plan write dispatcher | 유효, 신규 미커밋 |
| `src/main/bridge.ts` | 기존 bridge auth 이후 `/planner/relay` route와 structured error mapping 추가 | 유효, 미커밋 |
| `extension/background.js` | message allowlist, document ownership 재확인, `/planner/relay` forwarding 추가 | 유효, 미커밋 |
| `extension/content.js` | complete block parser, fenced-code 차단, ID dedupe, operation limit, result injection 및 epoch guard 추가 | 유효, 미커밋 |
| `test/codex-mhj_26_09_02_08_planner-relay.test.ts` | Relay validation, read/search/list/write, bounds, root fail-closed 테스트 | 유효, 신규 미커밋 |
| `test/bridge.test.ts` | bridge bearer/auth, valid dispatch, unknown tool 테스트 | 유효, 미커밋 |
| `test/extension.test.ts` | background forwarding과 stale document 차단 테스트 | 유효, 미커밋 |
| `test/content-script.test.ts` | parser, fenced code, dedupe와 result injection 테스트 | 유효, 미커밋 |
| `codex-mhj_26_09_03_01_session_summary.md` | 본 세션의 작업·검증·산출물 기록 | 유효, 신규 미커밋 |

### 5.1 참조한 파일 (수정하지 않음)

| 파일 | 설명 |
| --- | --- |
| `C:\Users\mhj\Downloads\chatonsteroids_planner_relay_codex_prompt.md` | Planner Relay 요구사항 원문 |
| `AGENTS.md` | repository architecture, staged workflow, safety 및 reporting 규칙 |
| `package.json` | test, typecheck, build script 확인 |
| `src/main/planner/codex-mhj_26_09_02_01_types.ts` | 기존 Planner type 계약 |
| `src/main/planner/codex-mhj_26_09_02_03_repository.ts` | 기존 bounded tree/read/search API |

### 5.2 저장소 상태

| 경로 | branch | 비고 |
| --- | --- | --- |
| `C:\Users\mhj\orca\workspaces\chat-on-steroids\arowana` | `mhj-smartinsideai/feat-webmcp-thin-proxy` | dirty worktree; 본 로그 및 Relay 변경은 미커밋 |

기존 사용자 또는 다른 agent의 변경으로 보이는 `README.md`, `docs/tool-surface.md`, `extension/chatgpt-dom.js`, `src/main/config.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/main/mcp/kernel.ts`, `src/main/tunnel/locate.ts`, `src/main/version.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/shared/types.ts`, `src/main/full/`, `src/main/planner/` 내 기존 파일, 기존 session summary 및 full/planner test 파일은 보존했다.

## 6. 다음 단계 대기 항목

| 구분 | 항목 |
| --- | --- |
| 수동 검증 | 실제 ChatGPT Plus 대화에서 assistant의 complete `<local_tool>` 생성 → bridge 호출 → 새 user `<local_tool_result>` 주입 흐름 확인 필요 |
| 운영 확인 | 실제 승인 root가 정확히 `C:\Users\mhj\Desktop\mhj_workspace\orca_harness`로 설정된 상태에서 extension reload 후 Relay 동작 확인 필요 |
| Git | 사용자의 별도 지시 전까지 stage, commit, push는 수행하지 않음 |
