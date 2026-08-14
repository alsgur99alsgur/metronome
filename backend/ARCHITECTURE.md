# Metronome Backend Architecture

## Purpose and startup

`backend`는 FastAPI API, Concert graph 실행기, 저장소, Timer를 함께 제공한다.

- `main.py`: FastAPI app, Pydantic request 모델, route, run state/queue
- `desktop_backend.py`: 백엔드 데이터 파일 초기화, 선택적 Windows 콘솔 할당, Uvicorn 실행
- `app_config.py`: `config.json` 로드와 기본값 merge
- `json_serialization.py`: runtime datetime/date/time과 scalar의 JSON 저장 변환

데이터 루트는 `METRONOME_DATA_DIR`이며 미설정 시 `backend` 디렉터리다.

## API groups

### Server and Concert

- `GET /servers`
- `GET /playings`, `GET /playings/{name}`, `GET /playings-by-id/{id}`
- `POST /playings`

Concert JSON persistence와 ID/name 검증은 `concert_store.py`가 담당한다.

### Deployment

- `/deployments`와 `/deployments/file`
- `/deployments/rehearsals`, `/promote`, `/rollback`, `/move`
- `/deployments/transactions/{id}/prepare|commit|finalize`
- deployment directory API

`deployment_store.py`가 Playing/Rehearsal/Backup 이동, checksum, commit ID mismatch, transaction 보상을 담당한다.

### Stage resources and Oracle

- `/stage-resources` 및 schema/data/delete
- `/connections`
- `/admin/connections`, `/admin/connections/test`
- `/db-read/describe`, `/schema/infer`

`resource_store.py`는 Stage Cache와 메모리 전용 Concert Cache, `oracle_client.py`는 connection pool과 query/write, `schema_inference.py`는 실행 전 column 추론을 담당한다.

### Runs and Replay

- `POST /run`
- `GET /runs/{run_id}`와 node data
- `POST /runs/{run_id}/nodes/{node_id}/data/query`: 런 캐시 결과를 서버에서 필터·다중 정렬하고 offset/limit 페이지로 반환
- `POST /runs/{run_id}/cancel`
- `GET /opl/model`
- `GET /replays`, Replay 전체 파일 전송 `GET /replays/export`·`POST /replays/import`, Replay별 Cache 목록 `GET /replays/cache`, 특정 Cache 열기 `GET /replays/cache/{cache_id}`, 특정 Cache 삭제 `DELETE /replays/cache/{cache_id}`, Replay Cache 전체 삭제 `DELETE /replays/cache`

`replay_data_store.py`는 User/Timer/Event 실행의 replay 결과와 metadata를 저장한다. `cache_data_store.py`는 User/Replay Run 결과를 `replay/<concert>/<source-replay-id>/cache/<run-id>/`에 실행별로 저장한다. Stage Cache Read도 다른 Replay 대상 노드와 동일하게 읽은 DataFrame을 자체 Parquet으로 저장하므로 원래 Stage 파일 없이 다른 서버에서 재생할 수 있다. Replay export/import는 metadata, Replay Parquet, LP/MPS 등 Replay 본체 전체를 옮기며 `cache/`의 실행별 Run Cache는 포함하지 않는다. 원격 Replay는 실행 서버에 `<replay-id>_<source-server-name>` 폴더로 저장하고 같은 이름의 폴더가 이미 있으면 전송하지 않고 기존 사본을 사용한다.

User Run은 Replay와 Run Cache를 함께 저장하고, Timer/Event Run은 Replay만 저장한다. Replay Run은 선택 Replay를 로드하면서 새 Run Cache만 만든다.

실행 식별자 `runId`는 `<concert-name>_YYYYMMDD_HHMMSS_ffffff` 형식이며 메인 프로세스 안에서는 생성 시각을 단조 증가시켜 동시 요청 간 중복을 방지한다.

### Timer and external trigger

- `GET|PUT /timers`: 전체 Timer 설정 조회/교체
- `POST /events/trigger`: event producer가 즉시 실행 요청

내장 `TimerManager`는 HTTP를 다시 호출하지 않는다. 저장된 timer가 due가 되면 callback에 `concertName`과 `params`만 전달하고, `_queue_saved_concert`가 저장된 Concert를 로드해 `_queue_run`을 호출한다. Timer 실행은 run cache를 만들지 않는다(`cache_enabled=False`).

Timer 설정 저장 payload 예시:

```json
{
  "timers": [
    {
      "id": null,
      "name": "Every_5_Minutes",
      "concertName": "Daily_Concert",
      "intervalSeconds": 300,
      "firstRunAt": "2026-08-09T01:00:00.000Z",
      "enabled": true,
      "params": {
        "business_date": "2026-08-09",
        "batch_size": 1000
      }
    }
  ]
}
```

`/events/trigger`는 `EventRunRequest`를 사용한다. 백엔드가 `concertName`으로 Concert 파일을 로드하므로 `concertId`, `nodes`, `edges`는 요청에 포함하지 않는다.

```json
{
  "concertName": "Daily_Concert",
  "params": {
    "business_date": "2026-08-09",
    "batch_size": 1000
  }
}
```

Timer와 Event는 저장된 Concert 전체 실행만 지원한다. 선택 실행과 Replay를 포함한 편집 중 graph 실행은 수동 `/run` 경로가 담당한다.

## Build and execution pipeline

1. 수동 실행은 요청에 포함된 편집 중 Concert graph를 `main._queue_run`이 스냅샷으로 만들고, Timer/Event는 `main._queue_saved_concert`가 저장된 Concert를 로드한 뒤 `_queue_run`에 전달한다.
2. `concert_builder.build_concert`가 node JSON을 `Task` graph로 만든다.
3. loop block과 parent/child dependency를 연결하고 선택 실행이면 필요한 graph만 수집한다.
4. 실행마다 새 child process가 전달받은 Concert 스냅샷을 사용하고, 그 process 내부 `Executor`가 worker thread queue에서 Task를 실행한다. Concert Call의 하위 Concert는 Playing 저장소에서 ID로 조회한다.
5. node event가 in-memory run state와 `CacheDataStore`를 갱신한다.
6. 새 실행은 replay parquet/metadata를 저장하고, replay 실행은 저장된 결과를 읽는다.

Loop 내부 DAG는 dependency level별 독립 분기를 병렬 실행한다. `eachRow`와 `groupBy`는 iteration별 결과 공간을 분리한 뒤 iteration도 thread pool에서 병렬 실행하고, 최종 출력은 원래 row/group 순서로 결합한다. `allRows`는 이전 iteration 결과가 다음 iteration 입력이므로 iteration은 순차지만 각 iteration 내부 분기는 병렬이다. 한 Concert 내 Loop 작업 thread 수는 `executor.workers`를 넘지 않으며, Replay/Run Cache에는 최외곽 Loop의 마지막 iteration snapshot만 저장한다.

최외곽 마지막 iteration snapshot에서 Loop 내부 일반 노드는 해당 iteration 결과를 저장하지만, 각 Loop In 노드는 분할된 row/group 대신 그 Loop In의 유일한 부모가 전달한 전체 DataFrame을 Run Cache에 저장한다.

## Node implementations

`concert_builder.py`가 각 node를 Task로 변환한다.

- DB Read/Write: Oracle bind record 실행
- Python: `func_<node name>` compile/execute, scope에 `pd`, `pandas`, `np`, `numpy`, `concert_vars`, `params`
- OPL: `opl_builder.build_and_solve_opl`
- Concert Input/Output
- nested Concert Call과 self-call/depth 방지

Concert Call 경계에서는 호출자와 호출 대상의 Input 값만 각각 `callerParams`, `calledParams`로 전달·기록한다. 양쪽 Input 이름이 같아도 별도 공간으로 유지하며 Global 변수는 호출 경계를 넘어 전달하거나 Replay 목록에 노출하지 않는다. 호출 대상의 Global 변수는 해당 Concert 내부 실행에서만 사용한다.
- Concert/Stage Cache resource
- Loop In/Out

`eachRow`와 `groupBy` loop는 입력 iteration을 미리 DataFrame 리스트로 만들지 않고 한 건씩 생성한다. iteration별 출력도 임시 Parquet에 순차 기록한 뒤 최종 DataFrame만 로드하며, 모든 iteration의 출력 columns/dtypes는 동일해야 한다.

Loop 내부 결과와 OPL artifact는 iteration별로 저장하지 않으며 가장 바깥 Loop의 마지막 iteration에서 마지막으로 실행된 값만 남긴다. Loop 내부 DataFrame은 downstream edge마다 deep copy한다.

`task.py`는 Task primitive와 graph link 상태만 보유한다.

## Persistence layout

```text
<data-root>/
  playings/<directory>/<name>.concert
  rehearsals/<directory>/<name>.concert
  backups/<directory>/<name>@<version>@<timestamp>.concert
  replay/<concert>/<replay-id>/
    metadata.json
    <node-id>.parquet
    cache/metadata.json
  stage/cache/<cache>_<UTC-write-time>.parquet
  stage/cache/<cache>.current.json
  config.json
  servers.json
  connections.json
  connection_schema_cache.json
  timers.json
```

Concert/노드 이름은 `^[A-Za-z0-9_]+$`이며 누락·불일치 payload는 오류 처리한다. Replay와 cache metadata의 필수 필드도 fallback 없이 오류 처리한다.

Input 변수와 Global 변수 타입은 `string`, `number`만 허용한다. User/Timer/Event/Replay 실행 payload와 저장 Concert 모두 같은 백엔드 검증을 거치며 그 외 타입은 명확히 실패한다.

서버 Concert 파일 Open은 안전한 runtime root 내부 경로인지와 파일 존재 여부를 확인한 뒤 JSON을 그대로 반환하며 payload schema를 재검증하지 않는다. payload/ID/version/node 검증은 Rehearsal 준비 단계에서 수행한다. 서버 Concert 디렉터리의 각 폴더명은 Rehearsal 생성 시 `^[A-Za-z0-9_]+$`만 허용한다.

## Configuration

`config.json`:

- `backend.consoleMode`: Windows 백엔드 콘솔 표시 여부 (`true`/`false`)
- `oracle.poolMin`, `poolMax`, `poolIncrement`, `writeBatchSize`
- `executor.workers`, `timeoutSeconds`
- `storage.retentionDays`: Replay, run cache, Timer run-status, Stage Cache 버전 보관 일수 (기본 7일)

설정값은 필요한 시점마다 `config.json`을 다시 읽으므로 서버 재시작 없이 다음 사용부터 반영된다. Executor 설정은 새 실행부터 적용되고, Oracle pool 설정이 바뀌면 다음 pool 요청에서 기존 pool을 닫고 새 설정으로 생성한다. Windows `backend.consoleMode`도 파일 변경을 감지해 콘솔 창 표시를 갱신한다. 보존 기간 관리자는 주기적으로 최신 값을 읽어 만료된 Replay/cache/Timer run-status를 삭제한다. Playing, Rehearsal, Backup을 포함한 Concert 파일은 보존 정리 대상이 아니다.

Replay 목록과 run cache 조회에 Concert 이름이 있으면 `replay/<concert>/`만 탐색한다. 데이터 뷰어와 실행 상태 API는 Concert 이름을 전달하여 전체 replay 루트 순회를 피한다.

Stage Cache는 immutable version Parquet와 current pointer를 사용하고 이름별 writer lock으로 append/delete를 직렬화한다. writer가 비정상 종료하면 PID와 프로세스 생성 시각으로 stale lock을 판별해 회수한다. 만료된 Stage Cache 버전은 참조 추적 없이 삭제하며 대상 버전이 사라진 current pointer도 함께 제거한다. Replay와 Run Cache의 Parquet, metadata, LP/MPS는 최종 파일과 같은 디렉터리의 고유 임시 파일을 거쳐 원자적으로 교체한다. Concert Cache는 실행 child 메모리에만 존재하고 종료 시 폐기한다.

백엔드는 프런트 및 Admin 프런트와 독립적으로 실행·종료한다. 두 UI를 닫아도 백엔드는 종료되지 않으며, 백엔드도 UI 프로세스를 제어하지 않는다.

`servers.json`에는 정확히 하나의 `Local` 항목이 필요하다. `connections.json`은 Oracle 연결 설정, `connection_schema_cache.json`은 describe 실패 시 사용할 schema cache다.

## Validation

```bash
cd /Users/mh/Desktop/metronome
PYTHONPYCACHEPREFIX=/tmp/metronome_pycache backend/.venv/bin/python -m py_compile backend/main.py backend/run_process.py backend/app_config.py backend/cache_data_store.py backend/concert_builder.py backend/concert_store.py backend/deployment_store.py backend/desktop_backend.py backend/executor.py backend/json_serialization.py backend/opl_builder.py backend/oracle_client.py backend/replay_data_store.py backend/resource_store.py backend/schema_inference.py backend/server_manager.py backend/storage_retention.py backend/task.py backend/timer_manager.py backend/variable_types.py
```
