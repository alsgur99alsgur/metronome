# Metronome Frontend Architecture

## Purpose and entrypoints

`frontend`는 React 19, React Flow, Vite, Electron으로 구성된 Concert 편집 데스크톱 앱이다.

- `src/main.jsx`: React mount
- `src/App.jsx`: Concert `Flow`만 렌더링하는 앱 진입점
- `src/concert/Flow.jsx`: 데스크톱 앱 셸
- `src/concert/ConcertTabView.jsx`: 편집기의 중심 상태·동작 모듈
- `electron/main.cjs`: 백엔드 프로세스와 BrowserWindow lifecycle
- `electron/after-pack.cjs`: Windows 패키징 후처리

개발 시 `npm run dev`, 검증 시 `npm run build`, Windows 산출물은 `npm run build:win`을 사용한다.

## App shell

`Flow.jsx`가 다음을 소유한다.

- 로컬/원격 서버 목록과 health 확인
- File 메뉴를 `ConcertTabView` imperative API에 연결
- Stage Resources, Rehearsal, Stage Manager 열기
- 좌측 Concert 목록과 resize
- 선택 서버의 `apiBaseUrl` 전달

`ConcertListPanel.jsx`는 서버의 Playing/Rehearsal/Backup 목록과 디렉터리를 로드한다. 행 렌더링과 action은 `ConcertFileTable.jsx`가 담당한다.

## Concert editor state

`ConcertTabView.jsx`가 다음 상태를 한 곳에서 조정한다.

- 열린 Concert 탭과 active tab snapshot
- `nodes`, `edges`, React Flow selection
- Concert ID/commit/version/name/file handle
- input/global variables와 실행 parameter 값
- undo/redo history
- 실행 상태와 node별 결과
- Replay 선택과 cache open/clear
- 검색·output 하단 panel 크기
- node editor와 각종 modal

주요 경계 함수:

- `concertPayload`: 저장/API payload 생성 및 runtime 필드 제거
- `createTabFromConcertPayload`: 파일·서버 payload 검증 후 탭 생성
- `openConcertPayloadInTab`: 기존 탭 중복 확인 후 restore
- `saveConcertLocal`/`saveConcertAsLocal`: File System Access API 또는 download
- `runConcert`: `/run` 요청 및 polling 시작
- `saveEditor`: node editor 내용을 graph에 반영하고 schema inference 실행

## Graph and node types

`nodeTypes.js`가 React Flow type을 `Node.jsx`에 연결한다. 현재 node type은 다음과 같다.

- `dbRead`, `dbWrite`
- `python`
- `opl`
- `concert`
- `concertInput`, `concertOutput`
- `cacheRead`, `cacheWrite`
- `fileRead`, `fileWrite`
- `loopIn`, `loopOut`

노드 기본값은 `createNode` in `ConcertTabView.jsx`, node ID는 timestamp/type 기반 `makeNodeId`에서 생성한다. edge는 화면에서 `CenterEdge.jsx`를 사용하지만 저장 전 표시 전용 필드를 제거한다.

## Editors

- `DbEditor.jsx`: connection 선택, SQL, describe, bind 관련 입력
- `PythonEditor.jsx`: Monaco editor, Python template, input/output columns, dataframe helper UI
- `OplEditor.jsx`: Sets/Parameters/Variables/Objectives/Constraints와 Pyomo code preview
- `ConcertCallEditor.jsx`: 호출할 Playing Concert 선택, input variable mapping
- `ResourceEditor.jsx`: run/stage 범위의 cache/file resource 읽기·쓰기
- `InputEditor.jsx`, `OutputEditor.jsx`: Concert 입출력 경계 node

`nameValidation.js`는 Concert/노드 이름을 자동 변경하지 않고 검증한다. 변수 이름 로직은 아직 각 variable 관련 dialog에 분산되어 있다.

## Execution and Replay UI

- `RunParamsDialog.jsx`: 실행 전 input variable 값 입력
- `RunningDialog.jsx`: 실행 중 상태 및 cancel
- `ConcertOutputPanel.jsx`: node 상태·duration·result 요약
- `DataViewerWindow.jsx`: 별도 창의 dataframe filter/sort/CSV
- `ReplayDialog.jsx`: replay point와 source/caller/parameter 표시
- `ConcertSearch.jsx`: node data/code/variable 검색과 결과 이동

API 흐름은 `/run` → `/runs/{runId}` polling이며, 상세 dataframe은 `/runs/{runId}/nodes/{nodeId}/data`로 조회한다. Replay는 `/replays`, `/replays/cache`를 사용한다.

## Deployment UI

- `DeployDialog.jsx`: version과 directory를 선택해 Rehearsal 생성
- `ConcertManagerDialog.jsx`: promote, rollback, move, delete
- `StageResourcesDialog.jsx`: stage cache/file 생성·조회·삭제

배포 전 `prepareDeployment`가 commit ID와 deployment name을 payload에 반영한다.

## Electron lifecycle

일반 앱은 `electron/main.cjs`가 backend executable을 시작하고 token-protected `/desktop/health`, `/desktop/shutdown`을 사용한다. `--admin` 모드는 백엔드를 시작하지 않고 기존 로컬 서버에 연결해 `admin-dist`를 연다.

패키지 데이터 위치는 실행 파일 옆이며 Electron이 `METRONOME_DATA_DIR`로 백엔드에 전달한다.

## Validation

```bash
cd /Users/mh/Desktop/metronome/frontend
npm run build
```
