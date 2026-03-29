# whisper_server/setup.ps1
# Configura o ambiente Python para o Whisper Server (faster-whisper + Flask + Waitress).
#
# Execute a partir da raiz do projeto remote-flow:
#   .\whisper_server\setup.ps1
#
# Pre-requisito: Python 3.10+ no PATH, ou `uv` disponivel (https://docs.astral.sh/uv/).

$ErrorActionPreference = "Stop"

$ProjectRoot    = Split-Path -Parent $PSScriptRoot
$VenvDir        = Join-Path $ProjectRoot ".venv-whisper"
$Requirements   = Join-Path $PSScriptRoot "requirements.txt"
$DownloadScript = Join-Path $PSScriptRoot "download_model.py"
$PipExe         = Join-Path $VenvDir "Scripts\pip.exe"
$PythonExe      = Join-Path $VenvDir "Scripts\python.exe"

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "    RemoteFlow - Whisper Server Setup           " -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# --- Passo 1: Criar ambiente virtual -----------------------------------------

Write-Host "[WhisperServer] Criando ambiente virtual em: $VenvDir" -ForegroundColor Cyan

# Verifica se `python` esta disponivel no PATH e nao e o stub da Microsoft Store.
# Caso contrario, usa `uv venv` para criar o ambiente com Python 3.12.
$PythonAvailable = $false
$UseUv = $false
try {
    $pyOut = & python --version 2>&1
    if ($LASTEXITCODE -eq 0 -and ($pyOut -notmatch "Microsoft Store")) {
        # Verifica versão mínima: Python 3.10+
        if ($pyOut -match "Python (\d+)\.(\d+)") {
            $pyMajor = [int]$Matches[1]
            $pyMinor = [int]$Matches[2]
            if ($pyMajor -gt 3 -or ($pyMajor -eq 3 -and $pyMinor -ge 10)) {
                $PythonAvailable = $true
            } else {
                Write-Host "[WhisperServer] ⚠️  Python $pyMajor.$pyMinor encontrado — necessário 3.10+." -ForegroundColor Yellow
                Write-Host "   Tentando 'uv venv --python 3.12' como alternativa..." -ForegroundColor Yellow
            }
        } else {
            $PythonAvailable = $true
        }
    }
} catch {
    $PythonAvailable = $false
}

if ($PythonAvailable) {
    python -m venv $VenvDir
} else {
    $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($null -eq $uvCmd) {
        Write-Error "[WhisperServer] ERRO: Nem 'python' nem 'uv' encontrado no PATH. Instale Python 3.8+ ou uv."
        exit 1
    }
    Write-Host "[WhisperServer] 'python' nao encontrado no PATH. Usando 'uv venv' com Python 3.12." -ForegroundColor Yellow
    # --seed instala pip/setuptools/wheel na venv para compatibilidade
    & uv venv --python 3.12 --seed $VenvDir
    $UseUv = $true
}

Write-Host "[WhisperServer] Ambiente virtual criado." -ForegroundColor Green

# --- Passo 2: Atualizar pip --------------------------------------------------

Write-Host ""
Write-Host "[WhisperServer] Atualizando pip..." -ForegroundColor Cyan
if ($UseUv) {
    & uv pip install --upgrade pip --python $PythonExe --quiet
} else {
    & $PipExe install --upgrade pip --quiet
}
Write-Host "[WhisperServer] pip atualizado." -ForegroundColor Green

# --- Passo 3: Instalar dependencias ------------------------------------------

Write-Host ""
Write-Host "[WhisperServer] Instalando dependencias de: $Requirements" -ForegroundColor Cyan
if ($UseUv) {
    & uv pip install -r $Requirements --python $PythonExe
} else {
    & $PipExe install -r $Requirements
}
Write-Host "[WhisperServer] Dependencias instaladas." -ForegroundColor Green

# --- Passo 4: Verificar cublas64_12.dll (CUDA 12) ----------------------------

Write-Host ""
Write-Host "[WhisperServer] Verificando cublas64_12.dll (necessário para suporte CUDA 12)..." -ForegroundColor Cyan

$cublasFound = $false

# Tenta where.exe primeiro (encontra DLLs no PATH do sistema)
try {
    $whereResult = & where.exe cublas64_12.dll 2>&1
    if ($LASTEXITCODE -eq 0 -and $whereResult) {
        $cublasFound = $true
        Write-Host "[WhisperServer] cublas64_12.dll encontrado no PATH: $whereResult" -ForegroundColor Green
    }
} catch { }

# Se não encontrou no PATH, busca no diretório padrão do CUDA Toolkit
if (-not $cublasFound) {
    $cudaBasePath = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if (Test-Path $cudaBasePath) {
        $found = Get-ChildItem -Path $cudaBasePath -Recurse -Filter "cublas64_12.dll" -ErrorAction SilentlyContinue
        if ($found) {
            $cublasFound = $true
            Write-Host "[WhisperServer] cublas64_12.dll encontrado em: $($found[0].FullName)" -ForegroundColor Green
        }
    }
}

if ($cublasFound) {
    Write-Host "[WhisperServer] ✅ cublas64_12.dll disponível — suporte CUDA 12 ativo." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "⚠️  cublas64_12.dll NÃO encontrado." -ForegroundColor Yellow
    Write-Host "   O Whisper Server tentará GPU mas fará fallback para CPU se a DLL estiver ausente." -ForegroundColor Yellow
    Write-Host "   Para habilitar aceleração CUDA 12, instale o CUDA Toolkit 12.x:" -ForegroundColor Yellow
    Write-Host "   https://developer.nvidia.com/cuda-downloads" -ForegroundColor Cyan
    Write-Host ""
}

# --- Passo 5: Pre-baixar o modelo Whisper ------------------------------------

Write-Host ""
Write-Host "[WhisperServer] Baixando modelo Whisper (pode demorar na primeira vez)..." -ForegroundColor Cyan
& $PythonExe $DownloadScript
Write-Host "[WhisperServer] Modelo baixado e pronto." -ForegroundColor Green

# --- Concluido ---------------------------------------------------------------

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "    Setup concluido com sucesso!                " -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Para iniciar o servidor Whisper, execute:" -ForegroundColor Cyan
Write-Host "  .venv-whisper\Scripts\python.exe whisper_server\server.py" -ForegroundColor White
Write-Host ""
