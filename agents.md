# Metronome Agent Notes

이 파일을 먼저 보고 작업 범위를 좁힌다. 전체 검색 전에 아래 기능별 파일을 우선 확인해서 토큰을 아낀다.

## Project Root

- 실제 프로젝트: `/Users/mh/Desktop/metronome`
- Frontend: `/Users/mh/Desktop/metronome/frontend`
- Backend: `/Users/mh/Desktop/metronome/backend`
- DAG 저장소: `/Users/mh/Desktop/metronome/backend/dags`
- Replay 저장소: `/Users/mh/Desktop/metronome/backend/replay`

## Frontend DAG 화면

- 앱 셸/상단 File 메뉴 연결: `frontend/src/dag/Flow.jsx`
- 메인 DAG 화면/탭/상태/실행/저장/툴바/모달 연결: `frontend/src/dag/DagTabView.jsx`
- DAG 전체 스타일: `frontend/src/dag/Flow.css`
- React Flow node type 매핑: `frontend/src/dag/nodeTypes.js`
- 노드 렌더링/아이콘/상태/rows/time 표시: `frontend/src/dag/Node.jsx`
- 커스텀 edge 렌더링: `frontend/src/dag/CenterEdge.jsx`

## Frontend Editors

- Query/Write 노드 에디터, DB connection 목록, query describe: `frontend/src/dag/QueryEditor.jsx`
- Python 노드 에디터, 기본 Python template, input/output columns panel: `frontend/src/dag/PythonEditor.jsx`
- DAG Call 노드 에디터, 로컬 DAG 파일 open, 호출 DAG input parameter 필드: `frontend/src/dag/DagCallEditor.jsx`
- `dagInput` 노드 에디터: `frontend/src/dag/InputEditor.jsx`
- `dagOutput` 노드 에디터: `frontend/src/dag/OutputEditor.jsx`

## Frontend Modals

- 변수 관리 모달, input/global variables 편집: `frontend/src/dag/VariablesDialog.jsx`
- 실행 전 input parameter 입력 모달: `frontend/src/dag/RunParamsDialog.jsx`
- Replay point 선택/Open 모달: `frontend/src/dag/ReplayDialog.jsx`
- 에디터 닫기 전 저장 확인 모달: `frontend/src/dag/SaveChangesDialog.jsx`
- 실행 중 표시/Cancel 모달: `frontend/src/dag/RunningDialog.jsx`

## Frontend Search/Data Viewer

- DAG 검색 패널, 드래그 resize, 검색 결과 클릭: `frontend/src/dag/DagSearch.jsx`
- 노드 결과 데이터 별도 창, filter/sort/csv download: `frontend/src/dag/DataViewerWindow.jsx`

## Backend API

- FastAPI entrypoint, routes, run queue, cancel, scheduler/event trigger, replay list: `backend/main.py`
- JSON response `allow_nan=True`: `backend/main.py`
- API models: `DagSaveRequest`, `RunRequest`, `TriggerRunRequest`, `QueryDescribeRequest` in `backend/main.py`

## Backend DAG Build/Execution Logic

- Node JSON을 Task graph로 변환: `backend/dag_builder.py`
- Query/Python/Write/DAG Call/`dagInput`/`dagOutput` task 생성: `backend/dag_builder.py`
- `$variable` SQL/Python rewrite: `backend/dag_builder.py`
- Python node scope에 `pd`, `pandas`, `np`, `numpy`, `dag_vars`, `params` 제공: `backend/dag_builder.py`
- Query input DataFrame rows를 bind records로 한 번에 실행: `backend/dag_builder.py`
- DAG Call 실행, self-call 방지, 호출 DAG input/output 처리: `backend/dag_builder.py`
- 선택 실행 dependency 수집: `collect_dependencies` in `backend/dag_builder.py`

## Backend Runtime Executor

- Thread worker executor, timeout, cancel event, node event callback: `backend/executor.py`
- Replay mode에서 query/`dagInput` load/save: `backend/executor.py`
- DataFrame result summary, preview/data rows, duration/rows metadata 생성: `backend/executor.py`

## Backend Persistence

- DAG JSON save/load/list, 저장 전 runtime 필드 제거: `backend/dag_store.py`
- Replay parquet save/load/list, metadata load/save: `backend/replay_data_store.py`
- Task primitive and parent/child links: `backend/task.py`

## Backend Oracle

- Oracle connection config: `backend/connections.json`
- Oracle client, connection pool, query describe/execute/executemany records: `backend/oracle_client.py`
- Oracle unavailable fallback exception: `OracleUnavailable` in `backend/oracle_client.py`

## Common Feature Map

- 노드 모양/아이콘/선택 그림자: `Node.jsx`, `Flow.css`
- Query/Python editor fullscreen modal: `DagTabView.jsx`, `Flow.css`, `QueryEditor.jsx`, `PythonEditor.jsx`
- Search 패널 위치/resize/layout: `DagSearch.jsx`, `Flow.css`
- 변수 UI/input/global variables: `VariablesDialog.jsx`, state wiring in `DagTabView.jsx`
- 실행 파라미터 입력 모달: `RunParamsDialog.jsx`
- Replay point modal/open/run buttons: `ReplayDialog.jsx` and toolbar in `DagTabView.jsx`, backend `replay_data_store.py`, `main.py`
- Running modal/cancel: `RunningDialog.jsx`, `/runs/{run_id}/cancel` in `main.py`, cancel handling in `executor.py`
- DAG 파일 저장 payload 정리: `cleanNodeDataForSave`, `cleanEdgeForSave` in `DagTabView.jsx`, backend cleanup in `dag_store.py`
- DAG Call 편집 저장 문제: `DagCallEditor.jsx`, `saveEditor` and `editableNodeData` in `DagTabView.jsx`
- DAG Call 실제 실행 문제: `_build_dag_call_task`, `_execute_task_graph`, `_build_input_task`, `_build_output_task` in `dag_builder.py`

## Validation Commands

- Frontend build: `npm run build` in `/Users/mh/Desktop/metronome/frontend`
- Backend syntax check without writing project `__pycache__`:
  - `PYTHONPYCACHEPREFIX=/tmp/metronome_pycache python3 -m py_compile /Users/mh/Desktop/metronome/backend/main.py /Users/mh/Desktop/metronome/backend/app_config.py /Users/mh/Desktop/metronome/backend/cache_data_store.py /Users/mh/Desktop/metronome/backend/dag_builder.py /Users/mh/Desktop/metronome/backend/dag_store.py /Users/mh/Desktop/metronome/backend/executor.py /Users/mh/Desktop/metronome/backend/oracle_client.py /Users/mh/Desktop/metronome/backend/replay_data_store.py /Users/mh/Desktop/metronome/backend/task.py`

## Editing Notes

- 현재 DAG 스키마와 현재 코드 구조만 기준으로 구현한다.
- 예전 DAG 파일, 예전 필드명, 예전 노드 타입, 예전 replay metadata, 삭제된 모듈 구조를 지원하는 fallback·alias·변환·조건 분기를 작성하지 않는다.
- 구형 데이터가 현재 스키마와 맞지 않으면 조용히 보정하지 말고 명시적으로 실패하게 한다.
- UI 작업 시 모바일/좁은 화면 대응은 고려하지 않는다. 데스크톱 기준 화면만 맞춘다.
- React Flow 예약 타입인 `input`/`output`은 쓰지 않는다. DAG용 타입은 `dagInput`/`dagOutput`을 사용한다.
- DAG 파일에는 실행 중 생성되는 `runRows`, `runDurationMs`, `outputColumns`, edge `type`, `markerEnd`를 저장하지 않는다.
