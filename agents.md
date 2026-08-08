# Metronome Agent Notes

이 문서를 먼저 읽고 작업 범위를 좁힌다. Metronome은 Concert 그래프 편집 데스크톱 앱, FastAPI 실행 서버, 별도 관리 앱으로 구성된다. 과거 DAG 명칭이나 삭제된 `frontend/src/dag`, `backend/dag_*` 경로를 기준으로 작업하지 않는다.

## Project Root

- 프로젝트: `/Users/mh/Desktop/metronome`
- 데스크톱 프런트엔드: `frontend`
- FastAPI 백엔드 및 런타임 데이터: `backend`
- 관리 앱: `admin-frontend`
- Windows 패키징 진입점: `build-windows.ps1`

상세 구조는 다음 문서를 먼저 확인한다.

- 프런트엔드: `frontend/ARCHITECTURE.md`
- 백엔드: `backend/ARCHITECTURE.md`
- 관리 앱: `admin-frontend/ARCHITECTURE.md`

## Fast Routing Map

### Concert 편집 화면

- 앱 셸, 서버 선택, File/Stage/View 메뉴, 좌측 Concert 목록: `frontend/src/concert/Flow.jsx`
- 탭, 그래프 상태, 저장/열기, 실행/Replay, 에디터·모달 연결: `frontend/src/concert/ConcertTabView.jsx`
- 공통 스타일: `frontend/src/concert/Flow.css`
- React Flow 노드/edge: `Node.jsx`, `nodeTypes.js`, `CenterEdge.jsx`
- Concert/노드 이름 검증: `frontend/src/concert/nameValidation.js`; 백엔드 재검증은 `backend/concert_store.py`, `backend/concert_builder.py`

### Node editors

- DB Read/Write: `DbEditor.jsx`
- Python: `PythonEditor.jsx`
- OPL/Pyomo preview: `OplEditor.jsx`; 실제 모델 실행은 `backend/opl_builder.py`
- Concert Call: `ConcertCallEditor.jsx`
- Cache/File resource: `ResourceEditor.jsx`
- Concert Input/Output: `InputEditor.jsx`, `OutputEditor.jsx`

### Dialogs and panels

- 입력/전역 변수: `VariablesDialog.jsx`
- 실행 파라미터: `RunParamsDialog.jsx`
- Replay 선택: `ReplayDialog.jsx`
- 실행/취소: `RunningDialog.jsx`
- 배포/Rehearsal: `DeployDialog.jsx`
- Playing/Rehearsal/Backup 관리: `ConcertManagerDialog.jsx`, `ConcertListPanel.jsx`, `ConcertFileTable.jsx`
- Stage resource: `StageResourcesDialog.jsx`
- 검색/실행 결과: `ConcertSearch.jsx`, `ConcertOutputPanel.jsx`, `DataViewerWindow.jsx`

### Backend

- API 모델·route·run queue·timer/event/replay: `backend/main.py`
- node JSON → Task graph, Concert Call/loop/선택 실행: `backend/concert_builder.py`
- worker 실행, cancel/timeout/replay/cache event: `backend/executor.py`
- Concert 저장·이름/노드 검증: `backend/concert_store.py`
- Rehearsal/Playing/Backup transaction: `backend/deployment_store.py`
- Replay parquet/metadata: `backend/replay_data_store.py`
- 실행 런 캐시: `backend/cache_data_store.py`
- Stage cache/file resource: `backend/resource_store.py`
- Oracle pool/query/write/schema cache: `backend/oracle_client.py`
- Timer 저장·polling: `backend/timer_manager.py`
- 데스크톱 데이터 초기화·shutdown route: `backend/desktop_backend.py`

### Admin app

- 서버 열기, Timer 편집, DB Connection 편집: `admin-frontend/src/App.jsx`
- 전체 스타일: `admin-frontend/src/styles.css`

## Runtime Data

`METRONOME_DATA_DIR`가 설정되면 백엔드 데이터는 해당 경로를 사용하고, 없으면 `backend`를 사용한다.

- Playing Concert: `playings/*.concert`
- Rehearsal: `rehearsals/*.concert`
- Backup: `backups/*.concert`
- Replay/런 캐시: `replay/<concert>/<replay-id>/`
- Stage resource: `stage/`
- 설정: `config.json`, `servers.json`, `connections.json`, `timers.json`

저장된 runtime 데이터 파일을 테스트 fixture처럼 임의 수정하지 않는다.

## Current Schema Rules

- 현재 Concert schema와 현재 코드만 지원한다. 구형 DAG/Concert/replay 필드 alias나 fallback을 추가하지 않는다.
- 잘못되거나 누락된 필드는 조용히 보정하지 말고 사용자 또는 API 호출자에게 명시적으로 실패시킨다.
- Concert 파일 이름과 노드 이름은 영문자, 숫자, underscore만 허용한다: `^[A-Za-z0-9_]+$`.
- React Flow 예약 타입 `input`/`output` 대신 `concertInput`/`concertOutput`을 사용한다.
- 저장 시 runtime 필드(`status`, `runRows`, `runDurationMs`, `runLoopIterations`, `outputColumns`, `schemaError`)와 edge 표시 필드(`type`, `markerEnd`, handles)를 제거한다.
- 모바일/좁은 화면 대응은 범위에 포함하지 않는다. 데스크톱 레이아웃을 기준으로 한다.

## Validation Commands

- 프런트 빌드: `cd /Users/mh/Desktop/metronome/frontend && npm run build`
- 관리 앱 빌드: `cd /Users/mh/Desktop/metronome/admin-frontend && npm run build`
- 백엔드 구문 검사:

```bash
cd /Users/mh/Desktop/metronome
PYTHONPYCACHEPREFIX=/tmp/metronome_pycache backend/.venv/bin/python -m py_compile backend/main.py backend/app_config.py backend/cache_data_store.py backend/concert_builder.py backend/concert_store.py backend/deployment_store.py backend/desktop_backend.py backend/executor.py backend/json_serialization.py backend/opl_builder.py backend/oracle_client.py backend/replay_data_store.py backend/resource_store.py backend/schema_inference.py backend/server_manager.py backend/task.py backend/timer_manager.py backend/variable_types.py
```

- 프런트 lint는 기존 저장소 전체 lint 상태와 작업 범위를 구분해서 판단한다: `npm run lint`.

## Editing Notes

- dirty worktree의 관련 없는 변경은 사용자 작업으로 간주하고 보존한다.
- 프런트/백엔드 양쪽에 같은 schema 검증이 있다면 사용자 피드백은 프런트에서, 우회 방지는 백엔드에서 담당한다.
- API payload나 저장 schema를 바꾸면 `frontend`, `backend`, `admin-frontend` 소비자를 모두 검색한다.
- Electron 패키징 변경은 `frontend/electron/main.cjs`, `after-pack.cjs`, `frontend/package.json`, `build-windows.ps1`을 함께 확인한다.
