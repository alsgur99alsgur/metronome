# Metronome Backend Architecture

## Purpose and startup

`backend`는 FastAPI API, Concert graph 실행기, 저장소, Timer를 함께 제공한다.

- `main.py`: FastAPI app, Pydantic request 모델, route, run state/queue
- `desktop_backend.py`: 데스크톱 데이터 파일 초기화, Uvicorn 실행, token-protected shutdown
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

`resource_store.py`는 stage cache/file, `oracle_client.py`는 connection pool과 query/write, `schema_inference.py`는 실행 전 column 추론을 담당한다.

### Runs and Replay

- `POST /run`
- `GET /runs/{run_id}`와 node data
- `POST /runs/{run_id}/cancel`
- `GET /opl/model`
- `GET /replays`, `GET|DELETE /replays/cache`

`replay_data_store.py`는 실행 결과 parquet와 replay metadata를 저장한다. `cache_data_store.py`는 진행 중/최근 실행 상태와 node 요약을 저장하는 런 캐시이며 cache/file resource node 저장소와 다르다.

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

1. 수동 실행은 `main._queue_run`으로 직접 들어오고, Timer/Event는 `main._queue_saved_concert`가 저장된 Concert를 로드한 뒤 `_queue_run`에 전달한다.
2. `concert_builder.build_concert`가 node JSON을 `Task` graph로 만든다.
3. loop block과 parent/child dependency를 연결하고 선택 실행이면 필요한 graph만 수집한다.
4. `Executor`가 worker thread queue에서 Task를 실행한다.
5. node event가 in-memory run state와 `CacheDataStore`를 갱신한다.
6. 새 실행은 replay parquet/metadata를 저장하고, replay 실행은 저장된 결과를 읽는다.

## Node implementations

`concert_builder.py`가 각 node를 Task로 변환한다.

- DB Read/Write: Oracle bind record 실행
- Python: `func_<node name>` compile/execute, scope에 `pd`, `pandas`, `np`, `numpy`, `concert_vars`, `params`
- OPL: `opl_builder.build_and_solve_opl`
- Concert Input/Output
- nested Concert Call과 self-call/depth 방지
- run/stage cache/file resource
- Loop In/Out

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
  stage/
  config.json
  servers.json
  connections.json
  connection_schema_cache.json
  timers.json
```

Concert/노드 이름은 `^[A-Za-z0-9_]+$`이며 누락·불일치 payload는 오류 처리한다. Replay와 cache metadata의 필수 필드도 fallback 없이 오류 처리한다.

## Configuration

`config.json`:

- `oracle.poolMin`, `poolMax`, `poolIncrement`, `writeBatchSize`
- `executor.workers`, `timeoutSeconds`

`servers.json`에는 정확히 하나의 `Local` 항목이 필요하다. `connections.json`은 Oracle 연결 설정, `connection_schema_cache.json`은 describe 실패 시 사용할 schema cache다.

## Validation

```bash
cd /Users/mh/Desktop/metronome
PYTHONPYCACHEPREFIX=/tmp/metronome_pycache backend/.venv/bin/python -m py_compile backend/main.py backend/app_config.py backend/cache_data_store.py backend/concert_builder.py backend/concert_store.py backend/deployment_store.py backend/desktop_backend.py backend/executor.py backend/json_serialization.py backend/opl_builder.py backend/oracle_client.py backend/replay_data_store.py backend/resource_store.py backend/schema_inference.py backend/server_manager.py backend/task.py backend/timer_manager.py backend/variable_types.py
```
