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

## 2. 프런트엔드 UI 구조

### 2.1 전체 화면 구성

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

### 2.2 메인 메뉴

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

### 2.3 Concert 목록과 서버

오른쪽 위 **Server** 선택은 메인 화면의 Concert 목록, Stage 기능 및 실행 대상 서버를 결정한다. 서버를 변경할 때 선택한 서버의 health 확인이 실패하면 변경되지 않는다.

Concert 목록은 다음 상태를 보여준다.

- **Playing**: 실제 실행 및 Concert Call의 대상이 되는 Concert
- **Rehearsal**: Playing으로 승격하기 전 검증·준비 중인 Concert
- **Backup**: promote 또는 rollback 과정에서 보관된 이전 파일

Replay 선택 창의 서버 선택은 메인 화면 서버와 독립적이다. Replay 창에서 다른 서버를 선택해도 메인 실행 서버는 바뀌지 않으며, 선택은 창을 닫았다 다시 열어도 유지된다.

### 2.4 Concert 편집 도구 모음

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

### 2.5 캔버스 조작

- 팔레트 노드를 캔버스로 드래그해 추가한다.
- 노드의 handle을 다른 노드의 handle에 연결해 데이터 흐름을 만든다.
- 노드를 더블클릭하면 편집기를 연다.
- 노드 또는 edge를 선택하고 `Delete` 또는 `Backspace`를 누르면 삭제한다.
- 빈 영역을 드래그하면 여러 노드를 선택할 수 있다.
- 마우스 휠과 캔버스 컨트롤로 이동·확대·축소한다.
- 실행 결과가 있는 노드의 컨텍스트 메뉴에서 **View Data**를 선택하면 별도 Data Viewer에서 결과를 확인한다.

일반 실행 노드의 이름은 영문자, 숫자, underscore만 사용할 수 있다. `Concert Input`과 `Concert Output`은 Concert마다 각각 하나만 추가할 수 있다.

### 2.6 Search, Output, Data Viewer

Search 검색어와 결과는 Output 패널로 전환하거나 Search 표시를 껐다 켜도 유지된다. Output 왼쪽 목록은 캔버스의 노드 상태 색상과 동일한 계열로 표시된다.

Data Viewer는 대용량 결과를 서버에서 페이지 단위로 읽으며 다음 기능을 제공한다.

- 필터와 다중 정렬
- 현재 페이지 검색 및 일치 셀 강조
- CSV 내보내기
- 열 너비 변경과 자동 맞춤
- 열 순서 변경 및 좌우 고정
- 행·열 선택

## 3. 노드 공통 사용법

모든 노드 편집기에는 다음 공통 필드가 있다.

- **Name**: 노드를 구분하는 이름. 실행 코드와 오류 메시지에도 사용한다.
- **Node ID**: 내부 식별자. 읽기 전용이며 실행 결과와 메모리상 스키마 계약의 기준으로 사용한다.
- **Save**: 편집 내용을 현재 Concert 메모리에 반영한다.
- **Cancel**: 편집 내용을 반영하지 않고 닫는다.

노드를 편집한 뒤 Concert 자체를 저장해야 `.concert` 파일에 반영된다. DB Read의 출력 컬럼 계약처럼 실행이나 스키마 추론으로 갱신되는 정보도 먼저 메모리에만 반영되고, 사용자가 Concert를 저장할 때 파일에 기록된다.

## 4. 노드별 설명서

### 4.1 DB Read

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

### 4.2 DB Write

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

### 4.3 Python

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

### 4.4 OPL

UI에서 최적화 모델을 구성하고 Pyomo 모델로 변환해 풀이한다.

**최소 필수 구성**

- Variable 1개 이상
- Objective 또는 Constraint 1개 이상

**Model 탭**

- **Sets**: 이름, Input node, Column을 지정한다.
- **Parameters**: 이름, Input node, Column 및 사용할 index set을 지정한다.
- **Variables**: 이름, 타입과 index set을 지정한다.
- **Objective & Constraints**: 수식, 조건, 설명을 작성한다. Objective는 하나만 추가할 수 있다.

Variable 타입은 NonNegative Real, NonNegative Integer, Binary를 지원한다. Constraint는 Name, Formula, Condition이 필요하며 Objective는 Condition을 사용하지 않는다.

**Options 탭**

- Objective Sense: Maximize 또는 Minimize
- Solver: HiGHS, Gurobi, CPLEX
- Timeout: solver 제한 시간
- MIP Gap: 상대 최적성 gap. `0.01`은 1%를 의미한다.

**View Pyomo Code**로 생성 예정 코드를 확인할 수 있다. 실행 결과와 함께 LP/MPS artifact가 생성될 수 있으며 결과 노드의 컨텍스트 메뉴에서 LP를 확인한다.

### 4.5 Concert Call

현재 실행 중인 child process 안에서 다른 Playing Concert를 호출한다. 호출마다 별도 process를 만들지 않는다.

**필수 설정**

- Concert Name

**동작**

- 선택한 이름으로 Playing 트리에서 대상 Concert를 찾는다.
- 대상이 없으면 not found, 같은 basename이 둘 이상이면 duplicate 오류가 발생한다.
- 로드된 Concert ID를 이용해 self call과 recursive call을 차단한다.
- 입력 DataFrame은 호출 대상의 Concert Input으로 전달되고, Concert Output 결과가 호출 노드의 결과가 된다.
- 호출자 Input 변수와 호출 대상 Input 변수는 이름이 같아도 별도 공간으로 구분한다.
- Global 변수는 호출 경계를 넘어 전달하지 않는다.

Input Parameters에는 호출 대상 Concert가 정의한 Input 변수 값만 지정한다. 지원 타입은 string과 number이다.

### 4.6 Concert Input

Concert Call로 전달된 입력 DataFrame을 호출 대상 Concert 내부로 들여오는 경계 노드다.

- 노드 이름 외 추가 필수 설정이 없다.
- 일반 사용자 실행에서 외부 DataFrame이 없으면 빈 DataFrame을 출력한다.
- 한 Concert에 하나만 추가할 수 있다.
- 부모 노드를 연결하지 않는다.

### 4.7 Concert Output

호출 대상 Concert의 최종 DataFrame을 호출자에게 반환하는 경계 노드다.

- 노드 이름 외 추가 필수 설정이 없다.
- 하나의 부모 DataFrame을 받아 그대로 출력한다.
- 한 Concert에 하나만 추가할 수 있다.

### 4.8 Cache Read

Stage 또는 현재 Concert 범위의 Cache를 읽어 DataFrame으로 출력한다.

**필수 설정**

- Scope: for Stage 또는 for Concert
- Cache Name

**Scope 차이**

- **Stage Cache**: 서버 디스크의 immutable Parquet 버전으로 저장된다. Read 시점의 current 버전을 읽는다.
- **Concert Cache**: 현재 child process 메모리에만 존재한다. 실행 종료 시 폐기되며 디스크, Replay, Run Cache에 별도 Cache 자체를 저장하지 않는다.

Stage Cache Read 결과는 Replay 대상일 때 읽은 DataFrame을 Replay Parquet에 함께 저장한다. 따라서 다른 서버로 Replay를 전송해도 원래 Stage Cache 파일 없이 실행할 수 있다. 같은 실행 서버의 Replay는 불필요한 파일 전송을 하지 않는다.

### 4.9 Cache Write

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

### 4.10 Loop In

Loop 블록의 시작점이며 유일한 부모 DataFrame을 iteration 단위로 나눈다. 연결된 Loop Out과 한 쌍으로 사용한다.

**Iteration Mode**

- **All rows**: 전체 DataFrame을 한 번에 처리한다. 이전 iteration 결과가 다음 iteration 입력이므로 iteration은 순차 실행된다.
- **Each row**: 입력을 한 행씩 분리한다. iteration은 worker thread pool에서 병렬 실행되므로 완료 순서가 원본 행 순서와 다를 수 있다.
- **Group by columns**: 지정 컬럼 조합별로 DataFrame을 분리한다. group iteration은 병렬 실행된다.

Group by columns에서는 추론된 Input Columns를 체크하거나 컬럼명을 수동으로 추가한다. Each row와 Group by columns는 실행 순서를 보장하지 않지만 최종 결과는 원래 row/group 순서에 맞춰 결합한다.

Loop 내부의 독립 DAG 분기도 병렬 실행된다. 한 Concert에서 사용하는 총 Loop 작업 thread 수는 `config.json`의 `executor.workers`를 넘지 않으므로 중첩 Loop가 단순히 `workers²`개의 thread를 만들지는 않는다.

### 4.11 Loop Out

Loop 블록의 종료점이며 iteration 결과를 결합하거나 All rows 반복의 종료 조건을 판단한다.

**All rows 모드 설정**

- **Max Iterations**: 최대 반복 횟수
- **Stop Conditions**: Output Column, 비교 연산자, 비교 값을 이용한 종료 조건
- 연산자: `==`, `!=`, `>=`, `>`, `<=`, `<`

왼쪽 Condition Columns를 더블클릭하거나 선택 후 `>>`를 눌러 조건으로 옮긴다. 조건 행의 **Delete** 또는 선택 후 `<<`로 제거한다. Each row와 Group by columns에서는 Max Iterations와 Stop Conditions를 사용하지 않는다.

Replay와 Run Cache에는 iteration별 전체 이력을 저장하지 않는다. 각 Loop는 해당 Loop 기준 마지막 iteration 결과를 유지하며, 최외곽 Loop의 마지막 iteration snapshot만 영구 저장 대상이 된다. 최외곽 마지막 snapshot의 Loop In 결과는 분할된 row/group가 아니라 Loop In의 유일한 부모가 전달한 전체 DataFrame이다.

Loop 내부 DataFrame은 각 downstream edge에 deep copy되어 한 분기의 변경이 다른 분기 입력을 직접 바꾸지 않는다.

### 4.12 Text

캔버스에 설명과 메모를 배치하는 실행되지 않는 노드다.

- Text 내용
- 배경색
- 글자색
- 글자 크기

Text 노드는 edge handle이 없고 실행 graph, schema inference 및 Replay/Run Cache에서 제외된다. 크기를 변경하거나 앞/뒤 레이어로 이동해 Concert 구조를 설명하는 데 사용한다.

## 5. 노드 연결 요약

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

## 6. 다음 문서화 단계

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
