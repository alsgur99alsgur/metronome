# Metronome Admin Frontend Architecture

## Purpose

`admin-frontend`는 실행 중인 Metronome 서버를 관리하는 별도 React/Vite 앱이다. Concert graph를 편집하지 않고 Timer와 Oracle connection 설정만 관리한다.

- `src/main.jsx`: React mount
- `src/App.jsx`: 모든 화면과 API 호출
- `src/styles.css`: 전체 admin UI 스타일
- `vite.config.js`: Vite 설정

Electron은 `--admin` 인자로 실행될 때 백엔드를 새로 시작하지 않고, 패키지의 `admin-dist/index.html`을 열어 기존 Local 서버에 연결한다.

## App structure

현재 `App.jsx`는 작은 단일 파일 앱이며 다음 component를 포함한다.

- `ServerOpenDialog`: 서버 목록 로드와 health 확인
- `MessageDialog`: 성공/오류 modal
- `SetTimerView`: Timer table과 Concert input parameter 편집
- `DsnEditorDialog`: 긴 Oracle DSN 편집
- `DbConnectionsView`: connection 설정, password 유지/변경, 연결 테스트
- `App`: 열린 서버별 tab과 좌측 navigation

서버를 열면 host/port별 tab이 만들어지고 각 tab에서 Timers 또는 DB Connections 화면을 선택한다.

## Timer flow

1. `GET /timers`와 `GET /playings`를 병렬 호출한다.
2. 선택 Concert의 `GET /playings/{name}`으로 input variable 정의를 읽는다.
3. 사용자가 timer 이름, Concert, 주기, 최초 실행 시간, enabled, parameter 값을 편집한다.
4. 모든 행을 `PUT /timers`의 `{ "timers": [...] }`로 한 번에 저장한다.

화면의 interval 값/unit은 저장 전에 초(`intervalSeconds`)로 변환하고 `datetime-local` 값은 ISO UTC 문자열(`firstRunAt`)로 변환한다. `params` key는 input variable 이름에서 `$`를 제거한 값이다.

## DB connection flow

- `GET /admin/connections`: 저장 설정 조회
- `PUT /admin/connections`: 전체 connection 배열 교체
- `POST /admin/connections/test`: 행 단위 연결 테스트

connection 필드는 `originalName`, `name`, `user`, `password`, `dsn`, `enable`, `pm`이다. 기존 password가 설정된 행은 사용자가 새 password를 입력하지 않으면 백엔드가 기존 값을 유지한다.

## API and error handling

모든 API base URL은 사용자가 연 서버의 `http://<host>:<port>`다. 실패 response는 `responseError`가 JSON `detail` 또는 text를 사용자에게 표시한다. 서버 open 전 `/health`를 호출해 연결 가능 여부를 확인한다.

## Validation

```bash
cd /Users/mh/Desktop/metronome/admin-frontend
npm run build
```
