# Metronome Frontend Architecture

## Purpose and entrypoints

`frontend`는 React 19, React Flow, Vite, Electron으로 구성된 Concert 편집 데스크톱 앱이다.

- `src/main.jsx`: query에 따라 일반 앱과 DataViewer 창 entry를 동적 import한 뒤 React mount
- `src/windows/MainWindow.jsx`: 일반 앱 entry 및 로컬 Monaco 초기화
- `src/windows/DataViewerWindowApp.jsx`: opener payload를 한 번 인수해 DataViewer mount
- `src/App.jsx`: Concert `Flow`만 렌더링하는 앱 진입점
- `src/concert/Flow.jsx`: 데스크톱 앱 셸
- `src/concert/ConcertTabView.jsx`: 편집기의 중심 상태·동작 모듈
- `electron/main.cjs`: 백엔드 프로세스와 BrowserWindow lifecycle
- `electron/after-pack.cjs`: Windows 패키징 후처리

개발 시 `npm run dev`, 검증 시 `npm run build`, Windows 산출물은 `npm run build:win`을 사용한다.

사용자에게 표시하는 모든 오류는 `src/errors/ErrorDialog.jsx`의 공통
`ErrorDialogProvider`를 사용한다. 화면과 helper는 `showError` 또는
`reportError`를 호출하며 browser alert API나 화면별 error element를 만들지
않는다. Electron 앱 종료 시 표시되는 native 경고창만 예외다.

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
- `loopIn`, `loopOut`
- `text`: 저장 전용 메모 노드. edge handle이 없고 실행·schema inference graph에서 제외된다.

노드 기본값은 `createNode` in `ConcertTabView.jsx`, node ID는 timestamp/type 기반 `makeNodeId`에서 생성한다. edge는 화면에서 `CenterEdge.jsx`를 사용하지만 저장 전 표시 전용 필드를 제거한다.

## Editors

- `DbEditor.jsx`: connection 선택, SQL, describe, bind 관련 입력
- `PythonEditor.jsx`: Monaco editor, Python template, input/output columns, dataframe helper UI
- `OplEditor.jsx`: Sets/Parameters/Variables/Objectives/Constraints와 Pyomo code preview
- `ConcertCallEditor.jsx`: 호출할 Playing Concert 선택, input variable mapping
- `ResourceEditor.jsx`: Concert/Stage Cache 읽기·쓰기
- `InputEditor.jsx`, `OutputEditor.jsx`: Concert 입출력 경계 node
- `TextEditor.jsx`: 메모의 배경색·글자색·글자 크기와 plain-text Monaco editor

`nameValidation.js`는 Concert/노드 이름을 자동 변경하지 않고 검증한다. 변수 이름 로직은 아직 각 variable 관련 dialog에 분산되어 있다.

## Execution and Replay UI

- `RunParamsDialog.jsx`: 실행 전 input variable 값 입력
- `RunningDialog.jsx`: 실행 중 상태 및 cancel
- `ConcertOutputPanel.jsx`: node 상태·duration·result 요약
- `DataViewerWindow.jsx`: 별도 React 창의 dataframe payload 전달
- `src/data-viewer/DataViewer.jsx`: dataframe filter/sort/CSV와 가변 폭 row/column 가상화. column resize/auto fit/reorder/left-right pin, row·column 선택과 임시 highlight, edge auto-scroll selection을 지원한다. Concert node의 `View Data`는 DuckDB 기반 1,000행 단위 서버 필터·다중 정렬·페이지 조회를 사용하고, 상단 검색은 현재 페이지의 일치 cell만 별도 색으로 강조한다.
- `ReplayDialog.jsx`: replay point와 version/play type/player/parameter 표시 및 메인 실행 서버와 독립된 Replay 조회 서버 선택
- `RunCacheDialog.jsx`: 선택한 replay에 연결된 실행별 Run Cache 선택

Run Cache 선택창은 Replay 선택창 위에 열리며 닫으면 Replay 선택창으로 돌아간다. Cache 목록 조회와 Cache 결과 열기는 Replay 선택 상태를 변경하거나 Replay 원본 데이터를 로드하지 않는다.

Replay 조회 서버 선택은 Dialog를 닫아도 탭 상태에 유지되며 메인 창의 실행 서버를 변경하지 않는다. 다른 서버의 Replay Run은 실행 서버에 `<replay-id>_<source-server-name>` 사본이 있는지 먼저 확인하고, 없을 때만 Replay 본체 ZIP을 import한 다음 해당 로컬 ID로 실행한다.

Input/Global 변수 편집 UI는 `string`, `number` 타입만 제공한다.

로컬 Concert Open은 파일명과 payload 이름 일치를 요구하지 않고 version 및 노드 이름을 Open 시 검증하지 않는다. 서버의 Playing/Rehearsal/Backup Open은 Rehearsal 단계에서 검증된 파일을 신뢰하여 payload schema를 다시 검증하지 않는다.
- `ConcertSearch.jsx`: node data/code/variable 검색과 결과 이동

프런트는 `/runs/{runId}`를 polling한다. 실행 중에는 메인 프로세스 상태를, child 종료 후에는 Run Cache 또는 run-status fallback을 반환한다. User Run은 Replay와 Run Cache를 함께 만들고, Replay Run은 Run Cache만, Timer/Event Run은 Replay만 만든다.

Loop 내부 결과가 저장된 노드는 컨텍스트 메뉴의 `View Iterations`에서 반복 key를 조회한다. 반복별 Data는 별도 DataViewer로 열고 OPL 노드는 반복별 LP도 열 수 있다.

## Deployment UI

- `DeployDialog.jsx`: version과 directory를 선택해 Rehearsal 생성
- `ConcertManagerDialog.jsx`: promote, rollback, move, delete
- `StageResourcesDialog.jsx`: stage cache/file 생성·조회·삭제

배포 전 `prepareDeployment`가 commit ID와 deployment name을 payload에 반영한다.

## Electron lifecycle

패키지의 `metronome.cmd`는 공용 `electron.exe`를 일반 모드로 실행하고, `metronome_admin.cmd`는 같은 `electron.exe`를 `--admin` 모드로 실행해 `admin-dist`를 연다. 두 프런트는 백엔드 상태를 확인하거나 백엔드 프로세스를 시작·종료하지 않으며, 서버가 실행 중이지 않아도 각각 독립적으로 열린다.

패키지 데이터 위치는 실행 파일 옆이며 Electron이 `METRONOME_DATA_DIR`로 백엔드에 전달한다.

## Validation

```bash
cd /Users/mh/Desktop/metronome/frontend
npm run build
```
