# Windows build

Windows 패키지는 Windows PC에서 ZIP 형태로 생성한다. 압축을 해제한 디렉터리가
곧 Metronome의 실행 및 데이터 디렉터리다.

## Prerequisites

- 64-bit Windows 10/11
- Python 3.13 (64-bit)
- Node.js 22 LTS (64-bit)
- Visual C++ Redistributable 2015-2022 (Oracle/수치 라이브러리가 요구할 수 있음)

## Build

PowerShell에서 저장소 루트를 연 뒤 실행한다.

```powershell
.\build-windows.ps1
```

PowerShell 실행 정책이 로컬 스크립트를 막는 경우 현재 창에서만
`Set-ExecutionPolicy -Scope Process Bypass`를 먼저 실행한다.

완료되면 `frontend\release`에 Windows 포터블 ZIP이 생성된다. ZIP을 쓰기 가능한
위치(예: `C:\\Metronome-8000`)에 압축 해제한 후 실행한다.

압축을 해제한 디렉터리에는 다음 실행 파일과 런처가 포함된다.

- `metronome_backend.exe`: 독립적인 FastAPI 백엔드 실행 파일이다.
- `electron.exe`: 프런트와 Admin 프런트가 공유하는 Electron 런타임이다.
- `metronome.cmd`: `electron.exe`로 메인 프런트만 연다.
- `metronome_admin.cmd`: `electron.exe --admin`으로 Admin 프런트만 연다.

백엔드, 메인 프런트, Admin 프런트는 서로 시작하거나 종료하지 않는다. 필요한 프로세스를 각각 실행해야 하며 어떤 순서로 실행해도 다른 프로세스의 시작이 차단되지 않는다. 두 UI는 동일한 `electron.exe`를 공유하므로 런타임이 중복 패키징되지 않는다.

백엔드 콘솔 창은 `config.json`에서 설정한다.

```json
{
  "backend": {
    "consoleMode": true
  }
}
```

`true`이면 `metronome_backend.exe`가 Windows 콘솔을 할당해 로그를 표시하고, `false`이면 콘솔 없이 실행한다. 기본값은 `false`이며 변경 사항은 백엔드를 다음에 시작할 때 적용된다.

## Data location

실행 후 아래 항목은 모두 `electron.exe`와 같은 디렉터리 트리에 생성된다.

- `config.json`, `connections.json`, `connection_schema_cache.json`, `servers.json`, `timers.json`
- `playings`, `replay`, `stage`, `tmp`, `rehearsals`, `backups`

업데이트하거나 폴더를 삭제하기 전에 이 디렉터리를 백업한다. 여러 사용자가 같은
폴더를 동시에 사용하는 구성은 지원하지 않는다.

## External API access

백엔드는 `servers.json`의 `Local.port`에 지정된 포트로 모든 네트워크
인터페이스에서 수신한다. `Local` 항목은 정확히 하나 있어야 한다. 외부 PC에서
접속하려면 Windows Defender 방화벽에 해당 TCP 포트의 인바운드 규칙을 추가하고,
`http://<Windows-PC-IP>:<Local.port>/health`로 확인한다. 신뢰할 수 없는
네트워크에 포트를 직접 노출하지 않는다.

한 PC에서 여러 Metronome을 실행할 때는 ZIP을 서로 다른 디렉터리에 각각
압축 해제하고, 최초 실행 전에 각 디렉터리에 포함된 `servers.json`에서 서로 다른
`Local.port`를 지정한다.
