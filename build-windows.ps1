$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "This script must run on Windows."
}

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendRoot = Join-Path $ProjectRoot "backend"
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$AdminFrontendRoot = Join-Path $ProjectRoot "admin-frontend"
$BuildPython = Join-Path $BackendRoot ".venv-build\Scripts\python.exe"
$PyInstaller = Join-Path $BackendRoot ".venv-build\Scripts\pyinstaller.exe"

Push-Location $BackendRoot
try {
    if (-not (Test-Path $BuildPython)) {
        py -3.13 -m venv .venv-build
    }
    & $BuildPython -m pip install --upgrade pip
    & $BuildPython -m pip install -r requirements-build.txt
    & $PyInstaller --clean --noconfirm metronome-backend.spec
}
finally {
    Pop-Location
}

Push-Location $FrontendRoot
try {
    Push-Location $AdminFrontendRoot
    try {
        npm ci
        npm run build
    }
    finally {
        Pop-Location
    }

    npm ci
    npm run build:win
}
finally {
    Pop-Location
}

Write-Host "Portable ZIP created under frontend\release"
