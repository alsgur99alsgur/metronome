# Metronome 사용자 설명서

> 문서 범위: 앱 실행 방법, 프런트엔드 UI 구조, 노드별 사용법  
> 기준: 현재 Metronome 데스크톱 앱과 FastAPI 백엔드

## 1. 앱 실행

Metronome은 실행 서버인 **백엔드**와 Concert 편집 화면인 **프런트엔드**가 서로 독립된 프로그램이다. 프런트엔드를 종료해도 백엔드는 자동으로 종료되지 않으며, 백엔드가 실행되지 않은 상태에서도 프런트 창은 열릴 수 있다.

### 1.1 Windows 배포본 실행

압축을 푼 Metronome 폴더에서 다음 순서로 실행한다.

1. `metronome_backend\metronome_backend.exe`를 실행한다.
2. 백엔드가 시작될 때까지 기다린다. 기본 Local 서버 주소는 `http://127.0.0.1:8000`이다.
3. `metronome.cmd`를 실행한다.
4. 프런트 오른쪽 위의 **Server**가 `Local`인지 확인한다.

실행 파일 역할은 다음과 같다.

| 파일 | 역할 |
|---|---|
| `metronome_backend\metronome_backend.exe` | FastAPI 실행 서버, Concert 실행, Oracle 연결, Replay 및 Cache 관리 |
| `metronome.cmd` | 일반 Metronome Concert 편집 앱 실행 |
| `metronome_admin.cmd` | 서버·Timer·Oracle Connection을 관리하는 Admin 앱 실행 |
| `electron.exe` | 프런트 실행 엔진. 일반 사용자는 직접 실행하지 않고 `.cmd` 파일을 사용한다. |

백엔드 콘솔 표시 여부는 `metronome_backend\config.json`에서 설정한다.

```json
{
  "backend": {
    "consoleMode": true
  }
}
```

- `true`: 백엔드 콘솔을 표시한다.
- `false`: 생성된 백엔드 콘솔을 숨긴다.
- 실행 중 값을 변경해도 설정 감시기가 다음 변경을 반영한다.

프런트가 서버에 연결되지 않으면 백엔드 실행 여부, `servers.json`의 Local 주소, 방화벽 및 포트 `8000` 사용 여부를 확인한다. 프런트는 백엔드 연결을 위해 계속 재시도하지 않으므로, 백엔드를 나중에 실행했다면 프런트를 다시 실행한다.

### 1.2 개발 환경에서 실행

프로젝트 루트가 `/Users/mh/Desktop/metronome`인 개발 환경의 예시는 다음과 같다.

백엔드:

```bash
cd /Users/mh/Desktop/metronome/backend
.venv/bin/python desktop_backend.py
```

프런트 웹 개발 서버:

```bash
cd /Users/mh/Desktop/metronome/frontend
npm run dev
```

프런트를 Electron 창으로 미리 보려면 먼저 프런트를 빌드한 뒤 Electron을 실행한다.

```bash
cd /Users/mh/Desktop/metronome/frontend
npm run build
npx electron .
```

Admin 앱은 Admin 프런트를 먼저 빌드하고 `--admin` 인자를 사용한다.

```bash
cd /Users/mh/Desktop/metronome/admin-frontend
npm run build
cd /Users/mh/Desktop/metronome/frontend
npx electron . --admin
```

## 2. 백엔드 실행 구조

Metronome 프런트엔드는 Concert를 직접 실행하지 않는다. 사용자가 선택한 백엔드에 HTTP 요청을 보내고, 해당 백엔드가 Concert 파일·실행 상태·Oracle 연결·Replay와 Cache를 관리한다.

### 2.1 로컬 백엔드와 서버 백엔드

로컬 백엔드와 서버 백엔드는 서로 다른 종류의 프로그램이 아니다. 둘 다 동일한 Metronome FastAPI 백엔드이며 **어느 컴퓨터에서 실행되는지와 어떤 데이터 디렉터리를 사용하는지**가 다르다.

| 구분 | 로컬 백엔드 | 서버 백엔드 |
|---|---|---|
| 실행 위치 | 사용자의 PC | 공용 또는 원격 서버 |
| 프런트 표시 이름 | 반드시 `Local` | `servers.json`에 등록한 서버 이름 |
| 기본 역할 | 프런트 최초 연결, 서버 목록 제공, 로컬 Concert 실행·관리 | 해당 서버의 Playing Concert 실행, Timer/Event 처리, 서버 데이터 관리 |
| 데이터 | 로컬 Playing, Replay, Run Cache, Stage Cache, 설정 | 서버별 Playing, Replay, Run Cache, Stage Cache, 설정 |
| Oracle | 로컬 백엔드 child가 접근 가능한 DB | 서버 백엔드 child가 접근 가능한 DB |
| Timer | 로컬 `timers.json`의 Timer 실행 | 해당 서버의 `timers.json`에 등록된 Timer 실행 |

프런트가 시작되면 먼저 Local 백엔드의 `/servers` API에서 서버 목록을 읽는다. 사용자가 오른쪽 위 **Server**를 변경하면 프런트가 선택한 서버의 API에 직접 요청한다. Local 백엔드가 원격 서버 요청을 대신 전달하는 proxy 구조는 아니다.

따라서 서버마다 다음 데이터가 독립적으로 존재한다.

- Playing, Rehearsal, Backup Concert
- Replay와 Run Cache
- Stage Cache
- Oracle Connection 설정
- Timer 설정
- 실행 중인 run registry

다른 서버의 Replay를 선택해 실행할 때는 Source 서버에서 Replay 본체를 export하고 실행할 Target 서버로 import한 뒤 Target 서버에서 실행한다. Source와 Target이 같으면 복사하지 않는다.

### 2.2 Concert 실행 프로세스

백엔드 API 프로세스가 노드를 직접 실행하지 않는다. **Concert 실행 한 건마다 새로운 child process를 하나 생성**한다. 동시 실행 개수에는 별도 제한이 없으므로 여러 실행 요청은 각각 독립된 process로 시작될 수 있다.

```text
Metronome Frontend
        │ HTTP POST /run
        ▼
Backend Main Process
  1. 요청과 필수 필드 검증
  2. runId 생성
  3. main memory의 run registry 등록
  4. event queue와 cancel event 생성
  5. 새 Concert child process 시작
        │
        ▼
Concert Child Process (1 run = 1 process)
  1. 요청 시점의 Concert snapshot으로 Task graph build
  2. child 전용 Oracle connection pool 생성·재사용
  3. Executor worker thread에서 DAG와 Loop 실행
  4. Replay / Run Cache 저장
  5. 완료·오류·노드 상태를 event queue로 전송
  6. Concert Cache와 Executor 정리
  7. Oracle pool 종료 후 process 종료
        │
        ▼
Backend Run Monitor
  1. child event queue 수신
  2. main memory의 run 상태 갱신
  3. child 종료 확인 및 process handle 정리
        │ GET /runs/{runId}
        ▼
Frontend Polling → 상태와 결과 표시
```

메인 백엔드는 다음 역할만 담당한다.

- 실행 요청 검증과 child 생성
- run ID, 상태, PID와 실행 metadata 관리
- child가 보낸 노드 상태·로그·duration·완료·오류 수신
- 프런트의 `/runs/{runId}` polling 응답
- cancel 요청을 process-safe Event로 child에 전달
- Timer 실행 완료 상태를 TimerManager에 전달

child process는 다음 실행 자원을 독립적으로 소유한다.

- Concert Task graph와 Executor
- worker thread pool
- Oracle connection pool
- 실행 중인 DataFrame
- 메모리 전용 Concert Cache
- Replay 및 Run Cache writer

한 실행의 Oracle pool이나 Concert Cache를 다른 실행과 공유하지 않는다. child가 정상 완료되거나 오류·취소로 끝나면 Oracle pool을 명시적으로 닫고 메모리 자원을 정리한다. child가 비정상 종료되면 main monitor가 해당 run을 오류로 마감한다.

`executor.workers`는 process 개수가 아니라 **각 child process 내부에서 병렬 노드를 실행할 worker thread 수**다. 예를 들어 동시에 Concert 3개를 실행하고 workers가 4라면 child process 3개가 만들어지고 각 child가 최대 4개의 worker를 사용한다.

Concert Call은 새로운 process를 만들지 않는다. 호출 대상 Playing Concert를 현재 child 안에서 로드하고, 상위 실행의 worker 설정·timeout·cancel·로그 라우터·Loop semaphore를 공유하는 하위 Executor로 실행한다.

### 2.3 백엔드 데이터 디렉터리

백엔드 설정과 runtime 데이터는 `METRONOME_DATA_DIR`가 지정되어 있으면 해당 디렉터리에 저장하고, 지정되지 않았으면 다음 위치를 사용한다.

- Windows 패키지: `metronome_backend.exe`가 들어 있는 `metronome_backend` 폴더
- 개발 환경: 프로젝트의 `backend` 폴더

주요 파일과 폴더는 다음과 같다.

```text
<backend-data>/
  config.json
  servers.json
  connections.json
  timers.json
  playings/
  rehearsals/
  backups/
  replay/
  stage/
```

서버 백엔드는 각 서버 컴퓨터의 독립된 data directory를 사용한다. 한 서버의 `config.json`을 변경해도 다른 서버 설정에는 영향을 주지 않는다.

### 2.4 config.json

`config.json`은 해당 백엔드 instance의 실행 설정이다. 기본 형태는 다음과 같다.

```json
{
  "backend": {
    "consoleMode": true
  },
  "oracle": {
    "poolMin": 1,
    "poolMax": 4,
    "poolIncrement": 1,
    "writeBatchSize": 1000
  },
  "executor": {
    "workers": 3,
    "timeoutSeconds": 60,
    "nodeLogLimitKb": 1024
  },
  "storage": {
    "retentionDays": 7,
    "cacheMemoryLimitMb": 64
  }
}
```

| 설정 | 설명 |
|---|---|
| `backend.consoleMode` | Windows 백엔드 콘솔을 표시할지 결정한다. `false`여도 콘솔을 생성한 뒤 숨긴다. |
| `oracle.poolMin` | child별 Oracle pool의 최소 connection 수 |
| `oracle.poolMax` | child별 Oracle pool의 최대 connection 수 |
| `oracle.poolIncrement` | connection이 부족할 때 pool이 늘어나는 단위 |
| `oracle.writeBatchSize` | DB Write에서 executemany로 처리하는 batch 행 수 |
| `executor.workers` | child 내부 DAG와 Loop 병렬 실행에 사용할 worker 수 |
| `executor.timeoutSeconds` | 개별 노드 실행 제한 시간(초) |
| `executor.nodeLogLimitKb` | 노드별 stdout, stderr 및 traceback 보관 한도(KB) |
| `storage.retentionDays` | Replay, Run Cache, 만료된 Stage Cache 버전의 보관 기간 |
| `storage.cacheMemoryLimitMb` | 현재 설정 파일에 유지되는 Cache 메모리 한도 항목이다. 현재 실행 코드에서는 사용하지 않는다. |

설정 파일을 읽는 시점은 항목마다 다르다.

- `executor`와 Oracle 설정: 새 실행 또는 다음 pool 사용부터 반영
- `storage.retentionDays`: 다음 retention 순회부터 반영
- `backend.consoleMode`: 감시 thread가 변경을 확인해 실행 중인 콘솔 표시 상태에 반영

잘못된 타입이나 범위의 설정은 조용히 보정하지 않고 해당 기능을 사용할 때 명확한 오류를 발생시킨다.

### 2.5 servers.json

`servers.json`은 프런트와 Admin 앱에 표시할 백엔드 서버 주소 목록이다. **Local 백엔드의 `servers.json`이 프런트 최초 서버 목록의 기준**이다.

```json
[
  {
    "name": "Local",
    "host": "127.0.0.1",
    "port": 8000
  },
  {
    "name": "Production",
    "host": "10.20.30.40",
    "port": 8000
  },
  {
    "name": "DR",
    "host": "dr-metronome.example.com",
    "port": 8000
  }
]
```

| 필드 | 설명 |
|---|---|
| `name` | UI에 표시되는 고유 서버 이름 |
| `host` | protocol과 경로를 제외한 hostname 또는 IP 주소 |
| `port` | 백엔드가 수신하는 TCP port, `1`~`65535` |

검증 규칙은 다음과 같다.

- JSON 최상위 값은 비어 있지 않은 배열이어야 한다.
- 이름은 비어 있을 수 없고 목록 안에서 중복될 수 없다.
- `Local`이라는 이름의 항목이 정확히 하나 있어야 한다.
- host는 비어 있을 수 없고 `/`를 포함할 수 없다.
- host에 `http://` 또는 `https://`를 넣지 않는다.
- port는 `1`부터 `65535` 사이의 정수여야 한다.
- `Local`이 기본 서버이며 백엔드 실행 port도 Local 항목의 port를 사용한다.

프런트는 선택한 항목을 다음 주소로 조합한다.

```text
http://<host>:<port>
```

따라서 HTTPS reverse proxy처럼 별도 protocol 처리가 필요한 구성은 현재 `servers.json` 형식만으로 지정할 수 없다. 파일을 변경한 뒤 이미 열린 프런트의 서버 목록을 확실히 갱신하려면 프런트를 다시 실행한다.

`servers.json`은 서버 주소 목록일 뿐 인증정보, Oracle 접속정보 또는 Concert 데이터를 포함하지 않는다. Oracle 접속정보는 각 백엔드의 `connections.json`에서 별도로 관리한다.

## 3. 프런트엔드 UI 구조

### 3.1 전체 화면 구성

화면은 크게 다음 영역으로 나뉜다.

| 영역 | 위치 | 주요 기능 |
|---|---|---|
| 메인 메뉴 | 화면 상단 | 파일 저장·열기, Stage 작업, Concert 목록 표시 전환 |
| 서버 선택 | 화면 오른쪽 위 | 현재 조회·실행할 백엔드 서버 선택 |
| Concert 목록 | 화면 왼쪽 | Playing, Rehearsal, Backup Concert 조회 및 열기 |
| Concert 탭 | 작업 영역 상단 | 여러 Concert를 동시에 열고 전환 |
| 실행 도구 모음 | Concert 탭 아래 | 전체/선택 실행, Replay 선택 및 Replay 실행 |
| 노드 팔레트 | Concert 작업 영역 왼쪽 | 실행 노드와 Text 노드를 캔버스로 끌어다 놓기 |
| 캔버스 | 화면 중앙 | 노드 배치, 연결, 선택, 편집 |
| Search/Output 패널 | 화면 하단 | Concert 검색 및 실행 상태·결과 확인 |

### 3.2 메인 메뉴

#### File

- **New**: 빈 Concert를 새 탭에서 만든다.
- **Save**: 현재 Concert를 기존 로컬 파일에 저장한다. 저장 대상이 없으면 Save As와 동일하게 동작한다.
- **Save As**: 저장할 로컬 `.concert` 파일을 선택한다.
- **Open**: 로컬 `.concert` 파일을 연다.
- **Close**: 현재 Concert 탭을 닫는다. 저장하지 않은 변경이 있으면 확인 창이 표시된다.

#### Stage

- **Stage Caches**: 현재 서버의 Stage Cache를 생성·조회·삭제한다.
- **Rehearsal**: 현재 Concert를 선택한 서버의 Rehearsal 영역으로 보낸다.
- **Stage Manager**: Rehearsal, Playing, Backup 파일을 관리하고 promote, rollback, move, delete 작업을 수행한다.

#### View

- **Concert List**: 왼쪽 Concert 목록을 표시하거나 숨긴다.

### 3.3 Concert 목록과 서버

오른쪽 위 **Server** 선택은 메인 화면의 Concert 목록, Stage 기능 및 실행 대상 서버를 결정한다. 서버를 변경할 때 선택한 서버의 health 확인이 실패하면 변경되지 않는다.

Concert 목록은 다음 상태를 보여준다.

- **Playing**: 실제 실행 및 Concert Call의 대상이 되는 Concert
- **Rehearsal**: Playing으로 승격하기 전 검증·준비 중인 Concert
- **Backup**: promote 또는 rollback 과정에서 보관된 이전 파일

Replay 선택 창의 서버 선택은 메인 화면 서버와 독립적이다. Replay 창에서 다른 서버를 선택해도 메인 실행 서버는 바뀌지 않으며, 선택은 창을 닫았다 다시 열어도 유지된다.

### 3.4 Concert 편집 도구 모음

#### Edit

- **Undo / Redo**: 그래프와 변수 편집 기록을 되돌리거나 다시 적용한다.
- **Variables**: Input Variable과 Global Variable을 편집한다. 두 변수 모두 타입은 `string`과 `number`만 지원한다.

변수 이름은 `$`를 포함해 표시한다. 정의되지 않은 Input/Global 변수를 노드에서 사용하면 별도 변수로 자동 추가하지 않고 명확한 오류를 발생시킨다.

#### View

- **Search**: 노드 이름, 설정, SQL, Python 코드, 변수 등을 검색한다. 결과를 선택하면 해당 노드로 이동한다.
- **Output**: 실행 대상 노드의 상태, 처리 행 수, 실행 시간, 로그와 오류를 확인한다. 노드 목록을 선택하면 캔버스의 해당 노드로 이동한다.

#### Run과 Replay

- **Run All**: Text를 제외한 전체 Concert를 실행한다.
- **Run To Selected**: 선택 노드와 그 upstream, 필요한 Loop 블록만 실행한다.
- **Replay Points**: 저장된 Replay 목록을 열고 Replay point 또는 연결된 Run Cache를 선택한다.
- **Replay Run**: 선택 Replay를 로드해 전체 Concert를 실행한다.
- **Replay Run To Selected**: 선택 Replay를 사용해 선택 범위만 실행한다.
- **Close Replay**: 현재 선택한 Replay point를 해제한다.

수동 실행 정책은 다음과 같다.

| 실행 종류 | Replay | Run Cache |
|---|---|---|
| 일반 User Run | 새로 저장 | 새로 저장 |
| Replay Run | 선택 Replay 로드 | 새로 저장 |
| Timer/Event Run | 새로 저장 | 저장하지 않음 |

실행 전에 대상 노드의 필수 필드를 프런트에서 검사한다. 누락된 노드는 `error`로 표시되고, 모든 누락 항목을 하나의 오류 창에서 확인할 수 있다. 검증 실패 시 백엔드로 실행 요청을 보내지 않는다.

노드 상태는 다음 순서로 표시된다.

```text
skipped → pending → running → success 또는 error
```

실행 범위에 포함되지 않은 노드는 `skipped`이며 Run Cache에 불필요하게 기록하지 않는다.

### 3.5 캔버스 조작

- 팔레트 노드를 캔버스로 드래그해 추가한다.
- 노드의 handle을 다른 노드의 handle에 연결해 데이터 흐름을 만든다.
- 노드를 더블클릭하면 편집기를 연다.
- 노드 또는 edge를 선택하고 `Delete` 또는 `Backspace`를 누르면 삭제한다.
- 빈 영역을 드래그하면 여러 노드를 선택할 수 있다.
- 마우스 휠과 캔버스 컨트롤로 이동·확대·축소한다.
- 실행 결과가 있는 노드의 컨텍스트 메뉴에서 **View Data**를 선택하면 별도 Data Viewer에서 결과를 확인한다.

일반 실행 노드의 이름은 영문자, 숫자, underscore만 사용할 수 있다. `Concert Input`과 `Concert Output`은 Concert마다 각각 하나만 추가할 수 있다.

### 3.6 Search, Output, Data Viewer

Search 검색어와 결과는 Output 패널로 전환하거나 Search 표시를 껐다 켜도 유지된다. Output 왼쪽 목록은 캔버스의 노드 상태 색상과 동일한 계열로 표시된다.

Data Viewer는 대용량 결과를 서버에서 페이지 단위로 읽으며 다음 기능을 제공한다.

- 필터와 다중 정렬
- 현재 페이지 검색 및 일치 셀 강조
- CSV 내보내기
- 열 너비 변경과 자동 맞춤
- 열 순서 변경 및 좌우 고정
- 행·열 선택

## 4. 노드 공통 사용법

모든 노드 편집기에는 다음 공통 필드가 있다.

- **Name**: 노드를 구분하는 이름. 실행 코드와 오류 메시지에도 사용한다.
- **Node ID**: 내부 식별자. 읽기 전용이며 실행 결과와 메모리상 스키마 계약의 기준으로 사용한다.
- **Save**: 편집 내용을 현재 Concert 메모리에 반영한다.
- **Cancel**: 편집 내용을 반영하지 않고 닫는다.

노드를 편집한 뒤 Concert 자체를 저장해야 `.concert` 파일에 반영된다. DB Read의 출력 컬럼 계약처럼 실행이나 스키마 추론으로 갱신되는 정보도 먼저 메모리에만 반영되고, 사용자가 Concert를 저장할 때 파일에 기록된다.

## 5. 노드별 설명서

### 5.1 DB Read

Oracle SQL 조회 결과를 pandas DataFrame으로 출력한다.

**필수 설정**

- Connection
- SQL

**입력과 실행**

- SQL bind 변수와 같은 이름의 입력 DataFrame 컬럼이 있으면 입력 행별 bind record로 조회한다.
- 입력이 없으면 같은 이름의 Input/Global 변수 값을 bind 값으로 사용한다.
- Connection에는 고정 Connection 이름뿐 아니라 Input/Global 변수도 선택할 수 있다. Loop iteration마다 변수 값이 달라지면 서로 다른 Connection을 사용할 수 있다.
- SQL과 pandas query에서 Input/Global 변수는 `$variable_name` 형식으로 사용한다.

**Output Columns와 컬럼 계약**

- 편집기가 schema inference에 성공하면 조회 컬럼 이름과 타입을 `dbReadSchema` 계약으로 메모리에 저장한다.
- inference가 실패하면 Output Columns에 오류를 표시하고 기존 메모리 계약은 제거한다.
- 실제 실행이 성공해도 계약이 갱신된다. Loop 내부에서는 해당 실행의 최초 성공 조회 결과로 계약을 확정한다.
- PM 상태 등으로 Oracle 연결이 실패하면 저장된 계약을 이용해 빈 DataFrame을 반환한다. 계약이 없으면 명확한 오류가 발생한다.

### 5.2 DB Write

입력 DataFrame의 각 행을 Oracle `executemany` bind record로 전달해 SQL을 실행한다.

**필수 설정**

- Connection
- SQL

**사용법과 주의사항**

- 일반적으로 하나의 입력 DataFrame을 연결한다.
- DataFrame 컬럼 이름과 SQL bind 이름을 일치시킨다.
- 입력이 없으면 Concert 변수 값을 한 건의 bind record로 사용한다.
- 성공하면 입력 DataFrame을 그대로 다음 노드로 전달한다.
- Oracle 연결이 PM 상태로 실패하면 write를 실행하지 않고 입력 DataFrame을 전달한다.
- Replay Run에서는 DB Write를 실행하지 않는다. 입력 DataFrame만 다음 노드로 전달하고 해당 노드는 `skipped`로 기록한다.

### 5.3 Python

pandas DataFrame을 Python 코드로 변환한다.

**필수 설정**

- Code

노드 이름이 `transform_1`이면 다음 함수를 정의해야 한다.

```python
def func_transform_1(inputs):
    # inputs는 부모 노드 결과의 리스트
    return inputs[0].copy()
```

실행 scope에는 `pd`, `pandas`, `np`, `numpy`, `params`, `concert_vars`가 제공된다. 유효한 Python 식별자 형태의 변수는 이름으로도 접근할 수 있다.

편집기 왼쪽에서 부모별 Input Columns를 선택해 확인하고, 오른쪽에서 실행 후 Output Columns를 확인한다. Preset 메뉴는 filter, assign, join, union, groupby, sort 등 자주 사용하는 pandas 코드 작성을 돕는다.

`print()` 출력과 예외는 노드별 로그로 라우팅되어 Output 패널에서 확인할 수 있다. 로그는 `config.json`의 `executor.nodeLogLimitKb` 한도까지만 보관되며 기본값은 1024KB이다. 한도를 넘은 출력은 잘림 표시 후 버린다.

### 5.4 OPL

UI에서 최적화 모델을 구성하고 Pyomo 모델로 변환해 풀이한다.

**최소 필수 구성**

- Variable 1개 이상
- Objective 또는 Constraint 1개 이상

**Model 탭**

- **Sets**: 이름, Input node, Column을 지정한다.
- **Parameters**: 이름, Input node, Column 및 사용할 index set을 지정한다.
- **Variables**: 이름, 타입과 index set을 지정한다.
- **Objective & Constraints**: 수식, 조건, 설명을 작성한다. Objective는 하나만 추가할 수 있다.

Variable 타입은 NonNegative Real, NonNegative Integer, Binary를 지원한다. Constraint는 Name과 Formula가 필요하고 Condition은 선택 사항이다. Objective는 Condition을 사용하지 않는다.

#### 목적식과 제약식 문법

Formula와 Condition에는 UI에서 정의한 Set, Parameter, Variable의 **Name**을 그대로 사용한다. `model.` 접두사는 쓰지 않는다. 모든 이름은 영문자 또는 underscore로 시작하는 유효한 Python 식별자여야 한다.

지원하는 기본 표현은 다음과 같다.

| 종류 | 문법 예시 |
|---|---|
| 숫자 | `10`, `3.5` |
| 사칙연산 | `revenue - cost`, `price * quantity`, `amount / 100` |
| 거듭제곱 | `x ** 2` |
| 괄호 | `(price - cost) * quantity` |
| 비교 | `==`, `!=`, `>=`, `>`, `<=`, `<` |
| 등호 | `=`도 제약식과 Condition에서 `==`로 변환된다. |
| 합계 | `sum([SetName], expression)` |

일반 Python의 `sum(expression for i in set)` 문법은 사용하지 않는다. OPL 전용 합계 문법은 반드시 다음 형태로 작성한다.

```text
sum([index_set_1, index_set_2], expression)
```

대괄호 안에는 UI의 **Sets** 영역에서 정의한 Set 이름을 넣는다.

#### 단일 인덱스

다음 구성 요소가 있다고 가정한다.

- Set: `Products`
- Parameter: `profit`, Indexes = `Products`
- Variable: `make`, Indexes = `Products`

제품별 이익의 합을 최대화하는 목적식은 다음과 같다.

```text
sum([Products], profit[Products] * make[Products])
```

여기서 대괄호 안의 `Products`는 입력 DataFrame의 컬럼명이 아니라 OPL에 등록한 **Set 이름**이다. 실행 시 Set에 포함된 각 실제 값으로 치환된다.

#### 다중 인덱스

다음 구성 요소가 있다고 가정한다.

- Set: `Plants`
- Set: `Products`
- Parameter: `cost`, Indexes = `Plants, Products`
- Variable: `ship`, Indexes = `Plants, Products`

모든 공장과 제품 조합의 비용 합계는 다음과 같다.

```text
sum([Plants, Products], cost[Plants, Products] * ship[Plants, Products])
```

여러 Set을 `sum`에 넣으면 지정한 순서대로 중첩 순회한다. Parameter와 Variable의 인덱스 순서도 UI의 **Indexes**에서 선택한 순서와 일치시킨다.

#### 제약식의 바깥 인덱스

제약식에서는 `sum` 바깥의 대괄호에 사용한 Set이 해당 Constraint의 반복 인덱스로 자동 등록된다.

공장별 출하량 제한 예시:

```text
sum([Products], ship[Plants, Products]) <= capacity[Plants]
```

이 식에서:

- `Products`는 `sum` 내부에서 순회한다.
- `Plants`는 `sum` 바깥에 남아 있으므로 Constraint가 공장별로 생성된다.
- 각 공장에 대해 모든 제품의 `ship` 합계가 해당 공장의 `capacity` 이하인지 검사한다.

제품별 수요 충족 제약 예시:

```text
sum([Plants], ship[Plants, Products]) >= demand[Products]
```

이 경우 `Products`가 바깥 인덱스이므로 제품별 Constraint가 생성된다.

인덱스가 두 개 모두 바깥에 있으면 조합별 Constraint가 생성된다.

```text
ship[Plants, Products] <= route_limit[Plants, Products]
```

#### Condition 사용법

Condition은 선택 사항이며 Constraint를 생성할 index 조합을 제한할 때만 사용한다. Condition 결과가 참인 조합만 제약식을 만들고, 거짓인 조합은 건너뛴다.

활성화된 공장에만 제약식을 적용하는 예시:

```text
Formula:   sum([Products], ship[Plants, Products]) <= capacity[Plants]
Condition: enabled[Plants] == 1
```

Condition을 비워두면 Formula에서 결정된 모든 index 조합에 제약식이 적용된다. `True`를 입력할 필요가 없다. `True`를 입력해도 결과는 같지만 불필요하다.

Condition에만 등장한 Set도 Constraint의 바깥 반복 인덱스에 포함된다.

#### Scalar Parameter와 Variable

Indexes를 선택하지 않은 Parameter와 Variable은 대괄호 없이 사용한다.

```text
fixed_cost + unit_cost * total_quantity
```

Scalar Parameter는 연결된 입력 DataFrame의 첫 번째 행 값을 사용한다. 입력 DataFrame이 비어 있으면 오류가 발생한다.

#### Sparse index 처리

여러 Set을 사용하는 Variable은 선택한 Set들이 참조하는 동일한 입력 노드의 실제 index 조합만 생성한다. 입력에 존재하지 않는 조합은 자동 생성하지 않는다.

- `sum` 안에서 존재하지 않는 sparse Parameter/Variable 조합은 해당 항을 `0`으로 처리한다.
- Constraint에서 필요한 sparse key가 없으면 해당 index 조합의 Constraint를 건너뛴다.
- 따라서 누락된 조합을 반드시 오류로 취급해야 하는 모델이라면 OPL 실행 전에 입력 데이터를 검증해야 한다.

#### 문법 예제 모음

| 목적 | Formula | Condition |
|---|---|---|
| 전체 이익 최대화 | `sum([Products], profit[Products] * make[Products])` | 목적식은 사용하지 않음 |
| 공장별 생산능력 | `sum([Products], make[Plants, Products]) <= capacity[Plants]` | 비워 둠 |
| 제품별 최소 수요 | `sum([Plants], ship[Plants, Products]) >= demand[Products]` | `demand[Products] > 0` |
| 허용된 경로만 사용 | `ship[Plants, Products] <= route_limit[Plants, Products]` | `allowed[Plants, Products] == 1` |
| Binary 연결 | `quantity[Products] <= max_quantity[Products] * selected[Products]` | 비워 둠 |

#### 자주 발생하는 오류

- `sum(Products, ...)`: index 목록에 대괄호가 없으므로 오류다.
- `sum([i], ...)`: `i`라는 Set을 정의하지 않았다면 오류다. 임의의 index 별칭 대신 실제 Set 이름을 사용한다.
- `make[product]`: Set 이름이 `Products`라면 `make[Products]`로 작성해야 한다.
- `ship[Products, Plants]`: Variable의 Indexes 순서가 `Plants, Products`라면 순서를 반대로 쓰면 안 된다.
- `sum([Products], make[Plants, Products])`를 목적식에 단독 사용: `Plants`가 합산되지 않은 자유 index로 남으므로 오류다. 목적식에서는 필요한 모든 index를 `sum`에 포함한다.
- 정의하지 않은 Set, Parameter, Variable 이름 사용: 자동 생성하지 않고 실행 오류로 처리한다.

**Options 탭**

- Objective Sense: Maximize 또는 Minimize
- Solver: HiGHS, Gurobi, CPLEX
- Timeout: solver 제한 시간
- MIP Gap: 상대 최적성 gap. `0.01`은 1%를 의미한다.

**View Pyomo Code**로 생성 예정 코드를 확인할 수 있다. 실행 결과와 함께 LP/MPS artifact가 생성될 수 있으며 결과 노드의 컨텍스트 메뉴에서 LP를 확인한다.

### 5.5 Concert Call

현재 실행 중인 child process 안에서 다른 Playing Concert를 호출한다. 호출마다 별도 process를 만들지 않는다.

**필수 설정**

- Concert Name

**동작**

- 선택한 이름으로 Playing 트리에서 대상 Concert를 찾는다.
- 대상이 없으면 not found, 같은 basename이 둘 이상이면 duplicate 오류가 발생한다.
- 호출 대상에는 정확히 하나의 Concert Output 노드가 있어야 하며, 없거나 여러 개면 실행을 거부한다.
- 로드된 Concert ID를 이용해 self call과 recursive call을 차단한다.
- 입력 DataFrame은 호출 대상의 Concert Input으로 전달되고, Concert Output 결과가 호출 노드의 결과가 된다.
- 호출 대상도 같은 child process 안의 Executor로 실행되므로 일반 실행과 동일하게 DAG 분기와 Loop iteration을 병렬 처리한다.
- 호출자 Input 변수와 호출 대상 Input 변수는 이름이 같아도 별도 공간으로 구분한다.
- Global 변수는 호출 경계를 넘어 전달하지 않는다.

Input Parameters에는 호출 대상 Concert가 정의한 Input 변수 값만 지정한다. 지원 타입은 string과 number이다.

### 5.6 Concert Input

Concert Call로 전달된 입력 DataFrame을 호출 대상 Concert 내부로 들여오는 경계 노드다.

- 노드 이름 외 추가 필수 설정이 없다.
- 일반 사용자 실행에서 외부 DataFrame이 없으면 빈 DataFrame을 출력한다.
- 한 Concert에 하나만 추가할 수 있다.
- 부모 노드를 연결하지 않는다.

### 5.7 Concert Output

호출 대상 Concert의 최종 DataFrame을 호출자에게 반환하는 경계 노드다.

- 노드 이름 외 추가 필수 설정이 없다.
- 하나의 부모 DataFrame을 받아 그대로 출력한다.
- 한 Concert에 하나만 추가할 수 있다.

### 5.8 Cache Read

Stage 또는 현재 Concert 범위의 Cache를 읽어 DataFrame으로 출력한다.

**필수 설정**

- Scope: for Stage 또는 for Concert
- Cache Name

**Scope 차이**

- **Stage Cache**: 서버 디스크의 immutable Parquet 버전으로 저장된다. Read 시점의 current 버전을 읽는다.
- **Concert Cache**: 현재 child process 메모리에만 존재한다. 실행 종료 시 폐기되며 디스크, Replay, Run Cache에 별도 Cache 자체를 저장하지 않는다.

Stage Cache Read 결과는 Replay 대상일 때 읽은 DataFrame을 Replay Parquet에 함께 저장한다. 따라서 다른 서버로 Replay를 전송해도 원래 Stage Cache 파일 없이 실행할 수 있다. 같은 실행 서버의 Replay는 불필요한 파일 전송을 하지 않는다.

### 5.9 Cache Write

입력 DataFrame을 Cache에 추가하거나 조건에 맞는 행을 삭제한다.

**필수 설정**

- Scope
- Cache Name
- Operation
- Delete인 경우 Pandas Query Condition

**Append**

- 정확히 하나의 입력 DataFrame이 필요하다.
- 기존 Cache에 입력 행을 추가하고 입력 DataFrame을 다음 노드로 전달한다.

**Delete**

- 입력은 없어도 되며 최대 하나만 받을 수 있다.
- pandas query 조건에 맞는 Cache 행을 삭제한다.
- 조건에는 `$variable_name` 형식으로 Input/Global 변수를 사용할 수 있다.

Stage Cache write는 이름별 lock으로 직렬화되고 새 immutable Parquet 버전을 만든 뒤 current pointer를 원자적으로 교체한다. Concert Cache write는 child 메모리에서만 처리한다. Cache 이름은 설정 UI에서 영문자, 숫자, underscore만 허용한다.

### 5.10 Loop In

Loop 블록의 시작점이며 유일한 부모 DataFrame을 iteration 단위로 나눈다. 연결된 Loop Out과 한 쌍으로 사용한다.

**Iteration Mode**

- **All rows**: 전체 DataFrame을 한 번에 처리한다. 이전 iteration 결과가 다음 iteration 입력이므로 iteration은 순차 실행된다.
- **Each row**: 입력을 한 행씩 분리한다. iteration은 worker thread pool에서 병렬 실행되므로 완료 순서가 원본 행 순서와 다를 수 있다.
- **Group by columns**: 지정 컬럼 조합별로 DataFrame을 분리한다. group iteration은 병렬 실행된다.

Group by columns에서는 추론된 Input Columns를 체크하거나 컬럼명을 수동으로 추가한다. Each row와 Group by columns는 실행 순서를 보장하지 않지만 최종 결과는 원래 row/group 순서에 맞춰 결합한다.

Loop 내부의 독립 DAG 분기도 병렬 실행된다. 한 Concert에서 사용하는 총 Loop 작업 thread 수는 `config.json`의 `executor.workers`를 넘지 않으므로 중첩 Loop가 단순히 `workers²`개의 thread를 만들지는 않는다.

### 5.11 Loop Out

Loop 블록의 종료점이며 iteration 결과를 결합하거나 All rows 반복의 종료 조건을 판단한다.

**All rows 모드 설정**

- **Max Iterations**: 최대 반복 횟수
- **Stop Conditions**: Output Column, 비교 연산자, 비교 값을 이용한 종료 조건
- 연산자: `==`, `!=`, `>=`, `>`, `<=`, `<`

왼쪽 Condition Columns를 더블클릭하거나 선택 후 `>>`를 눌러 조건으로 옮긴다. 조건 행의 **Delete** 또는 선택 후 `<<`로 제거한다. Each row와 Group by columns에서는 Max Iterations와 Stop Conditions를 사용하지 않는다.

Replay와 Run Cache에는 iteration별 전체 이력을 저장하지 않는다. 각 Loop는 해당 Loop 기준 마지막 iteration 결과를 유지하며, 최외곽 Loop의 마지막 iteration snapshot만 영구 저장 대상이 된다. 최외곽 마지막 snapshot의 Loop In 결과는 분할된 row/group가 아니라 Loop In의 유일한 부모가 전달한 전체 DataFrame이다.

Loop 내부 DataFrame은 각 downstream edge에 deep copy되어 한 분기의 변경이 다른 분기 입력을 직접 바꾸지 않는다.

### 5.12 Text

캔버스에 설명과 메모를 배치하는 실행되지 않는 노드다.

- Text 내용
- 배경색
- 글자색
- 글자 크기

Text 노드는 edge handle이 없고 실행 graph, schema inference 및 Replay/Run Cache에서 제외된다. 크기를 변경하거나 앞/뒤 레이어로 이동해 Concert 구조를 설명하는 데 사용한다.

## 6. 노드 연결 요약

| 노드 | 일반적인 입력 | 출력 |
|---|---|---|
| DB Read | 선택 사항: bind 값이 있는 DataFrame | 조회 DataFrame |
| DB Write | 0~1개 DataFrame | 입력 DataFrame 또는 빈 DataFrame |
| Python | 0개 이상 DataFrame | 사용자 함수 반환값 |
| OPL | 모델에 등록한 여러 입력 DataFrame | 최적화 결과 DataFrame |
| Concert Call | 호출 대상에 전달할 DataFrame | 호출 대상 Concert Output |
| Concert Input | 부모 없음 | 호출자가 전달한 DataFrame |
| Concert Output | 1개 DataFrame | 동일 DataFrame |
| Cache Read | 부모 없음 | Cache DataFrame |
| Cache Write | Append 1개, Delete 0~1개 | 입력 DataFrame 또는 빈 DataFrame |
| Loop In | 1개 DataFrame | iteration 입력 |
| Loop Out | 1개 DataFrame | 결합 또는 최종 DataFrame |
| Text | 연결 없음 | 실행 결과 없음 |

## 7. 다음 문서화 단계

PPT 제작 전 다음 화면을 캡처하면 이 문서의 내용을 효율적으로 시각화할 수 있다.

1. 배포 폴더의 세 실행 파일
2. 메인 UI 전체 화면과 영역 번호 표시본
3. File, Stage, View 메뉴
4. Variables 창
5. Run/Replay 도구 모음과 Replay 선택 창
6. Search, Output, Data Viewer
7. 12개 노드 편집기
8. Each row/Group by 병렬 경고와 Loop Out Stop Conditions
9. Stage Cache 및 Stage Manager
10. 성공 실행과 오류 실행 예시
