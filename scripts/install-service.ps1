# install-service.ps1
# Instala o RemoteFlow como serviço Windows usando NSSM
# Execute como Administrador: powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1

param(
    [string]$ServiceName = "RemoteFlow",
    [string]$ProjectDir  = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  RemoteFlow — Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ─── Verifica se está rodando como Administrador ──────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "❌ Este script precisa ser executado como Administrador." -ForegroundColor Red
    Write-Host "   Clique com botão direito no PowerShell > 'Executar como administrador'" -ForegroundColor Yellow
    exit 1
}

# ─── Verifica Node.js ─────────────────────────────────────────────────────────
Write-Host "Verificando Node.js..." -NoNewline
try {
    $nodeVersion = node --version 2>&1
    Write-Host " $nodeVersion ✅" -ForegroundColor Green
} catch {
    Write-Host " ❌ Node.js não encontrado!" -ForegroundColor Red
    Write-Host "   Instale em: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# ─── Verifica opencode ────────────────────────────────────────────────────────
Write-Host "Verificando opencode..." -NoNewline
try {
    opencode --version 2>&1 | Out-Null
    Write-Host " ✅" -ForegroundColor Green
} catch {
    Write-Host " ⚠️  opencode não encontrado no PATH" -ForegroundColor Yellow
    Write-Host "   Certifique-se de que OPENCODE_BIN no .env aponta para o executável correto." -ForegroundColor Yellow
}

# ─── Instala dependências npm ─────────────────────────────────────────────────
Write-Host ""
Write-Host "Instalando dependências npm..."
Set-Location $ProjectDir
npm install --silent
Write-Host "Dependências instaladas ✅" -ForegroundColor Green

# ─── Verifica e cria .env ─────────────────────────────────────────────────────
$envFile = Join-Path $ProjectDir ".env"
if (-not (Test-Path $envFile)) {
    Write-Host ""
    Write-Host "⚠️  Arquivo .env não encontrado!" -ForegroundColor Yellow
    $exampleFile = Join-Path $ProjectDir ".env.example"
    if (Test-Path $exampleFile) {
        Copy-Item $exampleFile $envFile
        Write-Host "Criado .env a partir do .env.example ✅" -ForegroundColor Green
    } else {
        Write-Host "❌ .env.example também não encontrado. Verifique o projeto." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "IMPORTANTE: Edite o arquivo .env antes de continuar!" -ForegroundColor Red
    Write-Host "  Arquivo: $envFile" -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "Já editou o .env com seu DISCORD_TOKEN e demais configurações? (s/N)"
    if ($continue -ne "s" -and $continue -ne "S") {
        Write-Host ""
        Write-Host "Configure o .env e execute este script novamente." -ForegroundColor Yellow
        exit 0
    }
}

# ─── Testa inicialização do bot ───────────────────────────────────────────────
Write-Host ""
Write-Host "Testando inicialização do bot (aguarde 6 segundos)..."

$nodePath = (Get-Command node).Source
$scriptPath = Join-Path $ProjectDir "src\index.js"

$testJob = Start-Job -ScriptBlock {
    param($node, $script, $dir)
    Set-Location $dir
    & $node $script 2>&1
} -ArgumentList $nodePath, $scriptPath, $ProjectDir

Start-Sleep 6
$output = Receive-Job $testJob -ErrorAction SilentlyContinue
Stop-Job $testJob -ErrorAction SilentlyContinue
Remove-Job $testJob -ErrorAction SilentlyContinue

if ($output -match "Bot online") {
    Write-Host "Bot inicializou com sucesso ✅" -ForegroundColor Green
} elseif ($output -match "faltando" -or $output -match "missing") {
    Write-Host "❌ Configuração incompleta. Verifique o .env:" -ForegroundColor Red
    Write-Host $output -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "⚠️  Não foi possível confirmar a inicialização. Output:" -ForegroundColor Yellow
    Write-Host ($output | Select-Object -First 10 | Out-String)
    $proceed = Read-Host "Continuar com a instalação do serviço mesmo assim? (s/N)"
    if ($proceed -ne "s" -and $proceed -ne "S") { exit 1 }
}

# ─── Instala NSSM se não estiver presente ────────────────────────────────────
Write-Host ""
Write-Host "Verificando NSSM..." -NoNewline
$nssmPath = ""
try {
    $nssmPath = (Get-Command nssm -ErrorAction Stop).Source
    Write-Host " ✅ ($nssmPath)" -ForegroundColor Green
} catch {
    Write-Host " não encontrado. Instalando via winget..." -ForegroundColor Yellow
    try {
        winget install nssm --silent --accept-source-agreements --accept-package-agreements
        $nssmPath = (Get-Command nssm -ErrorAction Stop).Source
        Write-Host "NSSM instalado ✅" -ForegroundColor Green
    } catch {
        Write-Host "❌ Não foi possível instalar o NSSM automaticamente." -ForegroundColor Red
        Write-Host "   Instale manualmente em: https://nssm.cc/download" -ForegroundColor Yellow
        Write-Host "   Depois adicione ao PATH e execute este script novamente." -ForegroundColor Yellow
        exit 1
    }
}

# ─── Remove serviço existente (se houver) ────────────────────────────────────
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host ""
    Write-Host "Serviço '$ServiceName' já existe. Removendo versão anterior..."
    & $nssmPath stop $ServiceName 2>&1 | Out-Null
    Start-Sleep 2
    & $nssmPath remove $ServiceName confirm 2>&1 | Out-Null
    Write-Host "Serviço anterior removido ✅" -ForegroundColor Green
}

# ─── Registra o serviço ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "Registrando serviço '$ServiceName'..."

$logDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

& $nssmPath install $ServiceName $nodePath (Join-Path $ProjectDir "src\index.js")
& $nssmPath set $ServiceName AppDirectory $ProjectDir
& $nssmPath set $ServiceName AppStdout (Join-Path $logDir "output.log")
& $nssmPath set $ServiceName AppStderr (Join-Path $logDir "error.log")
& $nssmPath set $ServiceName AppRotateFiles 1
& $nssmPath set $ServiceName AppRotateOnline 1
& $nssmPath set $ServiceName AppRotateSeconds 86400
& $nssmPath set $ServiceName AppRotateBytes 10485760
& $nssmPath set $ServiceName Description "RemoteFlow — Expõe o OpenCode CLI via bot Discord"
& $nssmPath set $ServiceName Start SERVICE_AUTO_START
& $nssmPath set $ServiceName ObjectName LocalSystem

Write-Host "Serviço registrado ✅" -ForegroundColor Green

# ─── Inicia o serviço ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Iniciando serviço..."
& $nssmPath start $ServiceName
Start-Sleep 3

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "Serviço iniciado com sucesso ✅" -ForegroundColor Green
} else {
    Write-Host "⚠️  Serviço pode não ter iniciado corretamente." -ForegroundColor Yellow
    Write-Host "   Verifique os logs em: $logDir" -ForegroundColor Yellow
}

# ─── Resumo final ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup concluído!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Serviço: $ServiceName"
Write-Host "Status:  $((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status)"
Write-Host "Logs:    $logDir"
Write-Host ""
Write-Host "Comandos úteis:" -ForegroundColor Cyan
Write-Host "  nssm start  $ServiceName   # inicia"
Write-Host "  nssm stop   $ServiceName   # para"
Write-Host "  nssm status $ServiceName   # status"
Write-Host "  nssm edit   $ServiceName   # abre GUI de configuração"
Write-Host ""
Write-Host "O bot iniciará automaticamente com o Windows ✅" -ForegroundColor Green
Write-Host ""
