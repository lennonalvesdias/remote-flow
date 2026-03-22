$env:DEBUG = 'true'
$pinfo = New-Object System.Diagnostics.ProcessStartInfo
$pinfo.FileName = 'node'
$pinfo.Arguments = '--watch src/index.js'
$pinfo.WorkingDirectory = 'C:\Users\lenno\Projects\remote-flow'
$pinfo.UseShellExecute = $false
$pinfo.RedirectStandardOutput = $true
$pinfo.RedirectStandardError = $true
$pinfo.CreateNoWindow = $true
$pinfo.EnvironmentVariables['DEBUG'] = 'true'

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $pinfo

$outFile = [System.IO.StreamWriter]::new('C:\Users\lenno\Projects\remote-flow\bot_stdout.log', $false)
$errFile = [System.IO.StreamWriter]::new('C:\Users\lenno\Projects\remote-flow\bot_stderr.log', $false)

$outFile.AutoFlush = $true
$errFile.AutoFlush = $true

$outHandler = {
    param($sender, $e)
    if ($e.Data -ne $null) {
        $line = $e.Data
        $outFile.WriteLine($line)
        Write-Host $line
    }
}
$errHandler = {
    param($sender, $e)
    if ($e.Data -ne $null) {
        $line = $e.Data
        $errFile.WriteLine($line)
        Write-Host "STDERR: $line"
    }
}

$proc.add_OutputDataReceived($outHandler)
$proc.add_ErrorDataReceived($errHandler)

$proc.Start() | Out-Null
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

Write-Host "Bot started (PID $($proc.Id)) — waiting 180s..."
Start-Sleep -Seconds 180
Write-Host "Time is up — stopping bot..."
$proc.Kill()
$outFile.Close()
$errFile.Close()
Write-Host "Done."
