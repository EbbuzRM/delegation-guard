# Configura l'avvio automatico di sync-from-opencode.ps1 tramite Task Scheduler
# Esegue la sincronizzazione ogni 30 minuti quando l'utente è loggato.

$ErrorActionPreference = 'Stop'

$TaskName    = 'OpenCode-SyncFromPlugins'
$ScriptPath  = Join-Path $PSScriptRoot 'sync-from-opencode.ps1'
$TriggerMin  = 30  # minuti tra un'esecuzione e l'altra

if (-not (Test-Path $ScriptPath)) {
    Write-Error "Script non trovato: $ScriptPath"
    exit 1
}

# Verifica se l'attività esiste già
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Attività '$TaskName' già esistente. La aggiorno..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Crea il trigger: ogni N minuti, indefinitamente
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $TriggerMin) -RepetitionDuration (New-TimeSpan -Days 365)

# Azione: esegue PowerShell con lo script
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" `
    -WorkingDirectory $PSScriptRoot

# Impostazioni: avvia solo se l'utente è loggato, non svegliare il PC
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# Registra l'attività
Register-ScheduledTask `
    -TaskName $TaskName `
    -Trigger $trigger `
    -Action $action `
    -Settings $settings `
    -Description "Sincronizza delegation-guard da .opencode/plugins ogni $TriggerMin minuti" `
    | Out-Null

Write-Host "✅ Attività '$TaskName' creata con successo." -ForegroundColor Green
Write-Host "   Frequenza: ogni $TriggerMin minuti" -ForegroundColor Cyan
Write-Host "   Script: $ScriptPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Per disabilitare temporaneamente:" -ForegroundColor Yellow
Write-Host "  Disable-ScheduledTask -TaskName '$TaskName'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Per riabilitare:" -ForegroundColor Yellow
Write-Host "  Enable-ScheduledTask -TaskName '$TaskName'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Per eliminare definitivamente:" -ForegroundColor Yellow
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Per modificare la frequenza: apri Task Scheduler → $TaskName → Trigger → Modifica." -ForegroundColor DarkGray
