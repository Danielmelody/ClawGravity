Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'language_server' -and $_.CommandLine -match 'csrf_token' } | ForEach-Object {
    Write-Host "===== PID: $($_.ProcessId) ====="
    Write-Host $_.CommandLine.Substring(0, [Math]::Min(500, $_.CommandLine.Length))
    Write-Host ""
}
