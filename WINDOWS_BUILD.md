# Windows build

Windows 패키지는 Windows PC에서 생성한다. 설치 디렉터리가 곧 Metronome의 데이터 디렉터리이므로 `Program Files` 대신 쓰기 가능한 위치(예: `C:\\Metronome`)를 선택한다.

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

완료되면 `frontend\release`에 NSIS 설치 프로그램이 생성된다. 설치 화면에서 쓰기 가능한 설치 경로를 선택한다.

## Data location

설치 후 아래 항목은 모두 `Metronome.exe`와 같은 디렉터리 트리에 생성된다.

- `config.json`, `connections.json`, `connection_schema_cache.json`, `servers.json`, `timers.json`
- `playings`, `replay`, `stage`, `tmp`, `rehearsals`, `backups`

앱을 업데이트하거나 제거하기 전에 이 디렉터리를 백업한다. 여러 사용자가 같은 설치 폴더를 동시에 사용하는 구성은 지원하지 않는다.
