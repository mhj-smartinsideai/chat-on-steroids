# Session Summary — WebMCP Planner 및 Windows Tunnel 연결

**Date:** 2026-09-02
**Artifact:** `codex-mhj_26_09_02_07_session_summary.md`
**Workflow:** `logging`

---

## 1. 세션 목표

`chat_on_steroids_webmcp_planner_poc_luna_xhigh.md`의 방향에 따라 Chat On Steroids 앞에 얇은 local WebMCP Planner Bridge를 구현하고, 데스크탑 앱 접속 및 OpenAI Secure MCP Tunnel을 Windows 설치본에서 동작시키는 것을 목표로 했다.

## 2. 진행 경과

| 단계 | 내용 | 결과 |
| --- | --- | --- |
| Planner 구현 | `127.0.0.1:8771/planner`와 `/api/planner/*` backend, approved-root 기반 repository read/search 및 `docs/tasks/**` plan write를 추가 | 완료 |
| WebMCP 연결 | `document.modelContext.registerTool()`로 `repo_tree`, `repo_search`, `repo_read`, `plan_write` 등록 | ChatGPT desktop built-in browser에서 모두 `registered` 확인 |
| Desktop startup 보정 | 긴 복구 초기화가 끝나기 전에 Planner server가 시작되도록 `loadConfig()` 직후로 이동 | 완료 |
| Tunnel 진단 | `Tunnel unavailable`의 원인이 `tunnel-client was not found`임을 확인 | 원인 확정 |
| Tunnel runtime 보정 | `tunnel-client v0.0.12 win32-x64`를 checksum 검증 후 staging하고, `out/main` 및 source layout을 모두 탐색하도록 locator 수정 | 완료 |
| 설치본 패키징 | workspace의 Windows runtime extraction lock을 피하여 `%TEMP%` prefixed output에서 x64 NSIS installer 생성 | 완료 |
| 설치 및 smoke test | 기존 per-user 설치본을 silent install로 업데이트하고 설치본의 tunnel/process/port/UI 상태 검증 | `Connected`, OpenAI handshake verified |

## 3. 핵심 결정

| 항목 | 결정 |
| --- | --- |
| WebMCP 경계 | 기존 MCP surface, extension bridge, shell/terminal runtime과 Planner Bridge를 병합하지 않음 |
| Planner 보안 | 기존 approved-root authority를 재사용하며 arbitrary model path와 generic filesystem write를 허용하지 않음 |
| Planner write 범위 | `docs/tasks/**` 아래의 plan/macro/micro/status/review 문서로 제한 |
| Tunnel binary | Windows 개발/패키지에 pinned `tunnel-client v0.0.12`를 사용하고 runtime PATH보다 bundled copy를 우선함 |
| 패키징 output | workspace의 `release` lock을 피하기 위해 `C:\Users\mhj\AppData\Local\Temp\codex-mhj_26_09_02_01_chat-on-steroids-win-x64`를 사용함 |
| ChatGPT 연결 방식 | Planner WebMCP는 ChatGPT desktop built-in browser의 Site Tools 경로이고, terminal `exec_command`는 별도 `Chat On Steroids Core` custom MCP app 선택이 필요함 |

## 4. 검증 실적

| 항목 | 상태 |
| --- | --- |
| `npm ci` | `PASS` — lockfile 변경 없음 |
| `npm run typecheck` | `PASS` |
| Planner focused test | `PASS` — 7 passed |
| Sandbox/search/read targeted tests | `PASS` — 115 passed, 9 skipped |
| Bridge/MCP targeted tests | `PASS` — 281 passed |
| Tunnel tests | `PASS` — 29 passed, 1 skipped |
| `npm run build` | `PASS` |
| `git diff --check` | `PASS` |
| Planner forbidden-capability static audit | `PASS` — forbidden capability 미검출 |
| `npm run tunnel` | `PASS` — `tunnel-client v0.0.12 win32-x64 checksum ok` |
| 첫 `npm run dist:x64` | `FAIL` — 실행 중 `tunnel-client.exe` 잠금으로 `EPERM` |
| 재시도 `npm run dist:x64` 및 workspace direct builder | `FAIL` — `release`/작업 output의 `default_app.asar`에서 `EBUSY/EPERM` |
| `%TEMP%` direct electron-builder | `PASS` — x64 NSIS installer 생성 |
| silent installer 실행 | `PASS` — `INSTALLER_EXIT_CODE=0` |
| 설치본 artifact 확인 | `PASS` — 설치 경로에 `resources\tunnel\tunnel-client.exe`, `VERSION=v0.0.12` 존재 |
| 설치본 runtime | `PASS` — UI `Connected`, `Last verified handshake with OpenAI`, `tunnel-client.exe` 실행, ports `8765`/`8771` listening |
| ChatGPT desktop Planner smoke | `PASS` — `Planner Bridge: running`, `Site Tools API: detected`, 4개 tool registered |
| `npm run verify:privacy` | `FAIL` — 기존 commit의 non-noreply maintainer email 문제; 본 작업에서 변경하지 않음 |
| Full `npm test` clean termination | `BLOCKED` — 70 files/1820 passed/18 skipped assertions 후 약 69.66초에 interrupt; exit code는 0이나 자연 종료는 확인하지 못함 |
| ChatGPT custom Core의 실제 `exec_command` 호출 | `NOT RUN` — ChatGPT에서 `Chat On Steroids Core` custom app을 생성·선택하지 않은 상태 |
| Git commit/push | `NOT RUN` |

## 5. 작성·수정한 파일

기준 경로: `C:\Users\mhj\orca\workspaces\chat-on-steroids\arowana`

| 파일 | 설명 | 상태 |
| --- | --- | --- |
| `src/main/planner/codex-mhj_26_09_02_01_types.ts` | Planner request/response 및 tool contract types | 유효 |
| `src/main/planner/codex-mhj_26_09_02_02_security.ts` | loopback/origin/body/response/path boundary checks | 유효 |
| `src/main/planner/codex-mhj_26_09_02_03_repository.ts` | approved-root 기반 tree/search/read 및 bounded write | 유효 |
| `src/main/planner/codex-mhj_26_09_02_04_page.ts` | WebMCP Planner HTML/JS page 및 4개 tool registration | 유효 |
| `src/main/planner/codex-mhj_26_09_02_05_server.ts` | local Planner HTTP server lifecycle/routes | 유효 |
| `test/codex-mhj_26_09_02_06_planner.test.ts` | Planner contract/security regression tests | 유효 |
| `src/main/index.ts` | Planner startup을 config load 직후로 이동하고 shutdown lifecycle에 연결 | 유효 |
| `src/main/tunnel/locate.ts` | packaged, `out/main`, source layout의 tunnel binary discovery 보정 | 유효 |
| `resources/tunnel/` | Windows x64 개발용 `tunnel-client`, `cloudflared`, notices, `VERSION` staging | 유효; generated/ignored local asset |
| `resources/packaging/tunnel/win32/x64/` | Windows x64 installer input | 유효; generated/ignored local asset |
| `resources/packaging/rg/win32/x64/` | Windows x64 ripgrep installer input | 유효; generated/ignored local asset |
| `out/` | `electron-vite` build output | 유효; generated/ignored output |

### 5.1 참조한 파일 (수정하지 않음)

| 파일 | 설명 |
| --- | --- |
| `C:\Users\mhj\Downloads\chat_on_steroids_webmcp_planner_poc_luna_xhigh.md` | 원본 Planner POC prompt; 존재 및 45,896 bytes 확인 |
| `package.json` | build/test/tunnel/package scripts 확인 |
| `electron-builder.yml` | Windows `extraResources` 및 NSIS packaging contract 확인 |
| `scripts/package.mjs` | platform/arch staging 및 electron-builder orchestration 확인 |
| `scripts/fetch-tunnel-client.mjs` | pinned tunnel download/checksum/staging 동작 확인 |
| `src/main/tunnel/index.ts` | tunnel-client argv/env/health/readiness/runtime 오류 경로 확인 |
| `README.md` | release/setup 및 tunnel troubleshooting 확인 |
| `src/renderer/index.html`, `src/renderer/main.ts` | 기존 Chat On Steroids renderer와 camera UI 혼동 진단 |

### 5.2 임시 산출물 (소실 주의)

기준 경로: `C:\Users\mhj\AppData\Local\Temp\codex-mhj_26_09_02_01_chat-on-steroids-win-x64`

| 파일/디렉터리 | 설명 |
| --- | --- |
| `Chat-On-Steroids-Setup-x64.exe` | 생성된 x64 NSIS installer, 146,693,394 bytes; Windows Temp 정리 시 소실 가능 |
| `win-unpacked/` | installer 검증용 unpacked package; Temp 정리 시 소실 가능 |
| `release/win-unpacked*`, `release/codex-mhj_26_09_02_01_win-x64/` | workspace packaging 실패 시 남은 partial builder output; 성공 installer는 아님. 자동 삭제하지 않고 보존함 |

설치 후 사용 중인 실행본은 임시 installer가 아니라 `C:\Users\mhj\AppData\Local\Programs\Chat On Steroids\`에 있다.

### 5.3 저장소 상태

| 경로 | branch | 비고 |
| --- | --- | --- |
| `C:\Users\mhj\orca\workspaces\chat-on-steroids\arowana` | `mhj-smartinsideai/feat-webmcp-thin-proxy` | Planner/tunnel 변경 및 generated output이 dirty 상태 |
| `README.md`, `docs/tool-surface.md`, `src/main/mcp/kernel.ts` | same | 본 세션에서 수정하지 않은 기존 dirty 변경; 보존함 |
| `src/main/full/codex-mhj_26_09_02_01_adapter.ts`, `src/main/full/codex-mhj_26_09_02_02_page.ts`, `test/codex-mhj_26_09_02_03_full.test.ts` | same | 본 세션에서 수정하지 않은 기존 untracked full-mode scope; 보존함 |

## 6. 다음 단계 대기 항목

| 구분 | 항목 |
| --- | --- |
| ChatGPT account-side setup | ChatGPT web에서 Developer mode를 활성화하고 `Chat On Steroids Core` custom app을 현재 Tunnel/`No authentication`으로 생성·선택해야 terminal `exec_command`가 호출 가능함 |
| Plan limitation | OpenAI 정책상 full MCP/write 지원 범위는 workspace plan 및 Developer mode 권한에 좌우됨 |
| Runtime ownership | source dev app과 설치본은 single-instance를 공유하므로 동시에 실행하지 않음 |
| Installer retention | 재설치가 필요하면 Temp installer를 사용하거나 새 packaging을 수행함; 설치본은 이미 업데이트됨 |
