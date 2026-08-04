# Frontend–Backend Communication Events

## 기본 규칙

- Frontend는 서버 목록만 항상 coordinator인 `http://localhost:8000`에서 조회한다.
- 그 외 요청은 toolbar에서 선택한 서버의 `http://{host}:{port}`를 `apiBaseUrl`로 사용한다.
- 서버를 변경하면 Concert List, Concert Manager, Stage Resources, Run, Replay, DB 조회가 모두 새 `apiBaseUrl`을 사용한다.
- Concert의 표시 이름 `name`에는 디렉터리가 포함되지 않는다.
- 실제 배포 위치는 `deploymentPath`, 호출 대상 식별은 `concertId`를 사용한다.
- 브라우저 File Open/Save/Save As와 drag-and-drop은 File System API를 사용하며 backend와 통신하지 않는다.

## 서버 선택

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| 앱 시작 | GET | `http://localhost:8000/servers` | 없음 | `servers`, `defaultServerName`을 받아 Server 콤보박스를 구성한다. |
| Server 변경 | 없음 | 없음 | 없음 | 선택 서버의 `host`, `port`로 `apiBaseUrl`을 변경한다. 관련 컴포넌트가 아래 목록 API를 다시 호출한다. |

## Concert List 및 Open

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| Concert List 표시, 서버 변경, 목록 새로고침 | GET | `/deployments/directories` | 없음 | `concerts` 기준 디렉터리 트리를 구성한다. |
| Concert List 표시, 서버 변경, 목록 새로고침 | GET | `/deployments` | 없음 | `concerts`, `rehearsals`, `backups` 파일 목록을 구성한다. 두 GET은 병렬 호출된다. |
| Production Concert 더블클릭 | GET | `/concerts-by-id/{concertId}` | path: `concertId` | 현재 Production 경로를 ID registry로 찾고 Concert payload를 반환한다. |
| Production 경로 Open fallback | GET | `/concerts/{concert_name:path}` | path: storage 상대경로 | 경로에 있는 Production Concert payload를 반환한다. ID가 없는 호출 경로에서만 사용된다. |
| Rehearsal 또는 Backup 더블클릭 | GET | `/deployments/file?kind={kind}&path={path}` | query: `kind`, `path` | 선택한 실제 배포 파일 payload를 반환한다. |
| Concert Open 직후 | POST | `/schema/infer` | `nodes`, `edges`, variables, params | 각 노드·Edge의 추론 컬럼을 Open된 탭에 반영한다. DB Read가 있으면 Oracle describe가 수행된다. |

## 브라우저 파일 작업

| UI 이벤트 | Backend 통신 | 동작 |
|---|---|---|
| File → New | 없음 | 새 `concertId`와 빈 탭을 frontend에 생성한다. |
| File → Open | 없음 | File System Access API 또는 file input으로 `.concert` 파일을 읽는다. 이후 schema inference만 backend에 요청한다. |
| Drag & Drop Open | 없음 | 브라우저가 로컬 `.concert` 파일을 읽는다. 이후 schema inference만 backend에 요청한다. |
| File → Save / Save As | 없음 | 브라우저 파일 handle 또는 다운로드로 저장한다. 표시용 `name`은 basename만 저장한다. |
| 탭 Close | 없음 | dirty이면 frontend 확인창에서 Save/Discard/Cancel을 처리한다. |

## Concert Call

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| Concert Call → Browse 열기 | GET | `/deployments/directories` | 없음 | Production 디렉터리 트리를 구성한다. |
| Concert Call → Browse 열기 | GET | `/deployments` | 없음 | `concerts` 타입만 표시한다. |
| Browse에서 Concert 선택 | GET | `/concerts-by-id/{concertId}` | path: `concertId` | 최신 Production의 Input Variables를 읽고 Input Parameters UI를 구성한다. 노드에는 `concertId`와 basename `concertName`을 저장한다. |
| Concert Call 컨텍스트 메뉴 → Open Concert | GET | `/concerts-by-id/{concertId}` | path: `concertId` | 현재 Production 위치와 무관하게 ID로 Concert를 열고 schema inference를 수행한다. |
| Run 직전 호출 대상 검증 | GET | `/concerts-by-id/{concertId}` | 각 Concert Call의 ID | 누락된 호출 대상을 Run 시작 전에 검증한다. |
| Run 중 Concert Call 실행 | 내부 backend 호출 | `ConcertStore.load_by_id(concertId)` | HTTP 요청 없음 | backend worker가 ID registry에서 현재 Production 파일을 찾아 하위 Concert를 실행한다. |

## Deploy

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| Deploy 창 열기 | GET | `/deployments/directories` | 없음 | 선택 가능한 기존 Production 디렉터리를 표시한다. |
| Deploy 창 열기 | GET | `/deployments` | 없음 | 현재 Production과 버전을 조회한다. 두 GET은 병렬 호출된다. |
| Deploy 실행 | POST | `/deployments/rehearsals` | `concertId`, basename `name`, `deploymentPath`, `sourceName`, `version`, graph, variables, `allowVersionMismatch` | 지정 경로에 Rehearsal을 생성한다. 기존 Production이 있으면 현재 디렉터리만 허용한다. |
| 버전 불일치 | 없음 후 POST | 없음 후 `/deployments/rehearsals` | frontend 확인 후 `allowVersionMismatch=true` | 사용자가 승인하지 않으면 요청하지 않는다. backend도 승인 없는 버전 불일치를 409로 거부한다. |

## Concert Manager

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| Concert Manager 열기/작업 후 갱신 | GET | `/deployments/directories` | 없음 | 디렉터리 트리를 갱신한다. |
| Concert Manager 열기/작업 후 갱신 | GET | `/deployments` | 없음 | Production, Rehearsal, Backup 목록을 갱신한다. |
| Rehearsal → Promote | POST | `/deployments/promote` | `{ "name": storagePath }` | Rehearsal을 Production으로 승격하고 기존 Production을 Backup으로 이동한다. |
| Backup → Rollback | POST | `/deployments/rollback` | `{ "backupPath": path }` | 선택 Backup을 Production으로 복원하고 현재 Production을 다시 Backup한다. |
| Move Folder 버튼 | GET | `/deployments/directories` | 없음 | 목적지 선택용 디렉터리 트리를 표시한다. |
| Move 실행 | POST | `/deployments/move` | `{ "name": productionPath, "directory": targetDirectory }` | Production과 같은 `concertId`의 Backup 파일들을 함께 이동한다. |
| Concert/Rehearsal/Backup Delete | DELETE | `/deployments` | `{ "kind": "concert|rehearsal|backup", "path": filePath }` | 사용자가 확인한 실제 파일 하나를 삭제하고 목록을 갱신한다. |

## Stage Resources

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| File → Stage Resources 열기/갱신 | GET | `/stage-resources` | 없음 | Stage Cache/File 목록을 표시한다. |
| Stage Resource 생성 | POST | `/stage-resources` | `{ "kind": "cache|file", "name": resourceName }` | 빈 DataFrame 자원을 생성하고 목록을 갱신한다. |
| Stage Resource View | GET | `/stage-resources/{kind}/{name}/data` | path: kind, name | DataFrame rows, columns, dtypes를 받아 Data Viewer를 연다. 404는 빈 DataFrame으로 표시한다. |
| Stage Resource 삭제 | DELETE | `/stage-resources/{kind}/{name}` | path: kind, name | 이름 재입력 확인 후 자원을 삭제한다. |
| Cache/File 노드에서 `for Stage` 선택 | GET | `/stage-resources` | 없음 | 해당 kind의 Stage Resource 콤보박스를 구성한다. |
| Stage Cache/File 선택 | GET | `/stage-resources/{kind}/{name}/schema` | path: kind, name | 노드 에디터의 Columns 패널에 schema를 표시한다. |

## DB Editor 및 Schema

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| DB Read/Write 에디터 열기 | GET | `/connections` | 없음 | Oracle connection 이름 목록을 표시한다. |
| DB Read의 connection/SQL/params 변경 | POST | `/db-read/describe` | `connection`, `sql`, `params` | debounce 후 Oracle describe 결과를 Output Columns에 표시한다. |
| 노드 에디터 저장 후 downstream schema 갱신 | POST | `/schema/infer` | graph, variables, params, `startNodeId` | 변경 노드부터 downstream 컬럼을 다시 추론한다. |
| Concert 파일 Open | POST | `/schema/infer` | 전체 graph 및 variables | 전체 graph 컬럼을 추론한다. |

## Run 및 상태 조회

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| Run All / 선택 실행 / Replay Run | POST | `/run` | `concertId`, basename `concertName`, graph, variables, params, mode, selected, replay, replayId | `runId`, replay/cache ID와 queued 상태를 반환한다. |
| Run 진행 중 | GET | `/runs/{runId}` | path: runId | frontend가 반복 polling하여 Run 및 노드 상태를 갱신한다. |
| Running 창 → Cancel | POST | `/runs/{runId}/cancel` | path: runId | Run을 canceled 처리하고 실행기 cancel을 요청한다. |
| 노드 View Data | GET | `/runs/{runId}/nodes/{nodeId}/data` | path: runId, nodeId | 메모리 또는 수행 서버의 실행 cache에서 전체 노드 결과를 읽어 Data Viewer에 표시한다. |

## Replay 및 실행 Cache

| UI 이벤트 | Method | 주소 | 요청 | 응답 및 후속 동작 |
|---|---|---|---|---|
| 탭 Open/Run 완료/Replay 창 갱신 | GET | `/replays?concertName={basename}` | query: basename Concert 이름 | 해당 Concert Replay 목록만 로드한다. |
| Replay tree의 cache Open | GET | `/replays/cache?concertName={name}&replayId={id}` | query: Concert 이름, Replay ID | Replay에 연결된 최신 실행 cache와 노드 결과를 탭에 복원한다. |
| Replay tree의 cache Delete | DELETE | `/replays/cache?concertName={name}&replayId={id}` | query: Concert 이름, Replay ID | Replay metadata/parquet은 유지하고 실행 cache만 삭제한다. |
| Replay 실행 | POST | `/run` | 일반 Run payload + `replay=true`, `replayId` | Read 결과를 Replay에서 복원하고 부작용 Write를 skip하는 실행을 시작한다. |

## 현재 UI에서 직접 호출하지 않는 Backend API

다음 API는 scheduler, event producer 또는 deployment coordinator 같은 외부 호출자를 위한 것이다.

| 호출 주체/목적 | Method | 주소 | 요청 및 동작 |
|---|---|---|---|
| Scheduler 실행 | POST | `/scheduler/run` | `concertName`, params, mode, selected로 저장된 Production Concert를 실행한다. |
| Event 실행 | POST | `/events/trigger` | event trigger가 저장된 Production Concert를 실행한다. |
| Deployment transaction prepare | POST | `/deployments/transactions/{transactionId}/prepare` | Rehearsal 배포 파일을 transaction staging에 준비한다. |
| Deployment transaction commit | POST | `/deployments/transactions/{transactionId}/commit` | 준비된 transaction을 Rehearsal에 반영한다. |
| Deployment transaction compensate | DELETE | `/deployments/transactions/{transactionId}` | transaction이 만든 변경을 보상하고 staging을 삭제한다. |
| Deployment transaction finalize | POST | `/deployments/transactions/{transactionId}/finalize` | committed transaction staging을 정리한다. |
| Deployment directory 생성 | POST | `/deployments/directories` | `{ "directory": path }`; 현재 Deploy UI에서는 New Folder가 제거되어 직접 호출하지 않는다. |
| Concert payload backend 저장 helper | POST | `/concerts` | `concertId`, basename name, graph, variables, version을 저장한다. 현재 File Save는 브라우저 파일에만 저장한다. |
| Run 상세 조회 | GET | `/runs/{runId}?includeData=true` | 기본 polling보다 상세한 result data를 포함할 수 있다. 현재 UI polling은 `includeData=false`를 사용한다. |
| 상태 확인 | GET | `/health` | backend health, executor ID 등의 상태 확인용이다. |

## Backend 통신이 없는 주요 UI 이벤트

- 노드 추가·삭제·이동·크기 변경
- Edge 연결·교체·삭제
- Undo / Redo
- 노드 복사·붙여넣기
- Global Variables / Input Variables 편집
- Search panel 검색
- Output panel 표시
- Concert List 표시 여부 및 너비 변경
- Backup 트리 expand/collapse
- 탭 전환과 dirty 표시
- Python 코드와 SQL의 에디터 내 입력 자체

위 이벤트는 frontend state/history만 변경한다. DB describe, schema inference, Run, Save 또는 Deploy처럼 명시된 시점에만 backend 요청이 발생한다.
