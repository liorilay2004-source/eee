[CmdletBinding()]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot = (Join-Path $env:USERPROFILE '.codex\eee-local-collector\aegean-demand'),
    [ValidateRange(30, 270)][int]$TimeoutSeconds = 270
)

$ErrorActionPreference = 'Stop'
$taskMutex = [System.Threading.Mutex]::new($false, 'Global\EEE.Aegean.DemandCollector')
$taskLockHeld = $false
$taskProcess = $null
$taskProcessStarted = $false
$taskStart = $null
$taskSecretValue = $null
$taskSecretPointer = [IntPtr]::Zero
$taskSecureKey = $null
$taskExitCode = 1
$taskMetadataPath = $null
$taskMetadata = $null
$taskStage = 'validating_paths'

try {
    try { $taskLockHeld = $taskMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $taskLockHeld = $true }
    if (-not $taskLockHeld) { exit 0 }

    $taskRepo = (Resolve-Path -LiteralPath $RepoPath).Path
    $taskCollector = Join-Path $taskRepo 'collector\probe-aegean-demand.mjs'
    if (-not (Test-Path -LiteralPath $taskCollector -PathType Leaf)) { throw 'Collector script is missing' }
    $taskOutput = [System.IO.Path]::GetFullPath($OutputRoot)
    if ($taskOutput.Equals($taskRepo, [System.StringComparison]::OrdinalIgnoreCase) -or
        $taskOutput.StartsWith($taskRepo.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Collector output must stay outside the Git repository'
    }
    $taskRunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $taskRunDirectory = Join-Path $taskOutput $taskRunId
    [System.IO.Directory]::CreateDirectory($taskRunDirectory) | Out-Null
    $taskObservationPath = Join-Path $taskRunDirectory 'aegean-http-calendar-observations.json'
    $taskSummaryPath = Join-Path $taskRunDirectory 'aegean-demand-summary.json'
    $taskMetadataPath = Join-Path $taskRunDirectory 'metadata.json'
    $taskMetadata = [ordered]@{
        source = 'aegean_demand'
        runId = $taskRunId
        startedAt = [DateTime]::UtcNow.ToString('o')
        timeoutSeconds = $TimeoutSeconds
        queuedTrips = 0
        publishedTrips = 0
        acceptedFares = 0
        skippedTrips = 0
        tripErrors = 0
        status = 'running'
    }
    $taskMetadata | ConvertTo-Json | Set-Content -LiteralPath $taskMetadataPath -Encoding utf8

    $taskStage = 'loading_credential'
    $taskSecretPath = Join-Path $env:USERPROFILE '.codex\secrets\eee-local-collector.dpapi'
    if (-not (Test-Path -LiteralPath $taskSecretPath -PathType Leaf)) { throw 'Local collector credential is not provisioned' }
    $taskSecureKey = (Get-Content -LiteralPath $taskSecretPath -Raw).Trim() | ConvertTo-SecureString
    $taskSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureKey)
    $taskSecretValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskSecretPointer)
    if ($taskSecretValue -notmatch '^[a-f0-9]{64}$') { throw 'Invalid local collector configuration' }

    $taskStart = [System.Diagnostics.ProcessStartInfo]::new()
    $taskStart.FileName = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $taskStart.WorkingDirectory = $taskRepo
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskStart.ArgumentList.Add($taskCollector)
    $taskStart.Environment['COLLECTOR_KEY'] = $taskSecretValue
    $taskStart.Environment['AEGEAN_HTTP_OUTPUT_DIRECTORY'] = $taskRunDirectory
    $taskSecretValue = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskSecretPointer)
    $taskSecretPointer = [IntPtr]::Zero
    $taskSecureKey.Dispose()
    $taskSecureKey = $null

    $taskProcess = [System.Diagnostics.Process]::new()
    $taskProcess.StartInfo = $taskStart
    $taskStage = 'launching_collector'
    if (-not $taskProcess.Start()) { throw 'Could not start the local collector' }
    $taskProcessStarted = $true
    $taskStart.Environment.Remove('COLLECTOR_KEY') | Out-Null
    $taskStdout = $taskProcess.StandardOutput.ReadToEndAsync()
    $taskStderr = $taskProcess.StandardError.ReadToEndAsync()
    $taskStage = 'waiting_for_collector'
    $taskTimedOut = -not $taskProcess.WaitForExit($TimeoutSeconds * 1000)
    if ($taskTimedOut) {
        $taskProcess.Kill($true)
        $taskProcess.WaitForExit()
    }
    $taskStdout.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $taskRunDirectory 'stdout.log') -Encoding utf8
    $taskStderr.GetAwaiter().GetResult() | Set-Content -LiteralPath (Join-Path $taskRunDirectory 'stderr.log') -Encoding utf8
    $taskExitCode = if ($taskTimedOut) { 124 } else { $taskProcess.ExitCode }
    $taskMetadata['exitCode'] = $taskExitCode
    $taskMetadata['status'] = if ($taskTimedOut) { 'timed_out' } elseif ($taskExitCode -eq 0) { 'succeeded' } else { 'failed' }

    $taskStage = 'reading_receipts'
    if (Test-Path -LiteralPath $taskSummaryPath -PathType Leaf) {
        if ((Get-Item -LiteralPath $taskSummaryPath).Length -gt 32000) { throw 'Demand summary is oversized' }
        $taskSummary = Get-Content -LiteralPath $taskSummaryPath -Raw | ConvertFrom-Json
        if ($taskSummary.queuedTrips -isnot [long] -and $taskSummary.queuedTrips -isnot [int]) { throw 'Demand summary is invalid' }
        if ($taskSummary.queuedTrips -lt 0 -or $taskSummary.queuedTrips -gt 12) { throw 'Demand summary exceeds its bound' }
        $taskMetadata['queuedTrips'] = [int]$taskSummary.queuedTrips
    } elseif ($taskExitCode -eq 0) { throw 'Demand summary is missing' }

    $taskObservations = @()
    if (Test-Path -LiteralPath $taskObservationPath -PathType Leaf) {
        if ((Get-Item -LiteralPath $taskObservationPath).Length -gt 2000000) { throw 'Demand observations are oversized' }
        $taskRows = Get-Content -LiteralPath $taskObservationPath -Raw | ConvertFrom-Json -NoEnumerate
        if ($taskRows -isnot [System.Array] -or $taskRows.Count -gt 12) { throw 'Demand observation list is invalid' }
        $taskObservations = @($taskRows)
        $taskPublications = @($taskObservations | Where-Object { $null -ne $_.publication })
        foreach ($taskObservation in $taskPublications) {
            if ($taskObservation.publication.published -ne 1 -or
                $taskObservation.publication.checkedAt -cne $taskObservation.checkedAt) { throw 'Demand publication receipt mismatch' }
        }
        $taskMetadata['publishedTrips'] = $taskPublications.Count
        $taskMetadata['acceptedFares'] = $taskPublications.Count
        $taskMetadata['skippedTrips'] = @($taskObservations | Where-Object { $_.skipped -ceq 'claim_declined' }).Count
        $taskMetadata['tripErrors'] = @($taskObservations | Where-Object { $null -ne $_.error }).Count
    } elseif ($taskExitCode -eq 0) { throw 'Demand observations are missing' }

    if ($taskExitCode -eq 0) {
        if ($taskMetadata['tripErrors'] -ne 0 -or
            $taskMetadata['publishedTrips'] + $taskMetadata['skippedTrips'] -ne $taskMetadata['queuedTrips']) {
            throw 'Demand collection is incomplete'
        }
        if ($taskMetadata['publishedTrips'] -eq 0) { $taskMetadata['status'] = 'idle' }
    } elseif (-not $taskTimedOut -and $taskMetadata['publishedTrips'] -gt 0) {
        $taskMetadata['status'] = 'partial'
    }
} catch {
    # Stage names and fixed error text keep decrypted configuration out of output.
    if ($null -ne $taskMetadata) {
        $taskMetadata['status'] = 'failed'
        $taskMetadata['exitCode'] = 1
        $taskMetadata['error'] = 'Local demand collector could not complete; inspect the bounded collector output'
        $taskMetadata['failureStage'] = $taskStage
    }
    [Console]::Error.WriteLine("Local demand collector failed during $taskStage.")
    $taskExitCode = 1
} finally {
    $taskSecretValue = $null
    if ($null -ne $taskStart) { $taskStart.Environment.Remove('COLLECTOR_KEY') | Out-Null }
    if ($taskSecretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskSecretPointer) }
    if ($null -ne $taskSecureKey) { $taskSecureKey.Dispose() }
    if ($null -ne $taskProcess) {
        $taskProcess.StartInfo.Environment.Remove('COLLECTOR_KEY') | Out-Null
        if ($taskProcessStarted -and -not $taskProcess.HasExited) { $taskProcess.Kill($true) }
        $taskProcess.Dispose()
    }
    if ($null -ne $taskMetadataPath) {
        $taskMetadata['completedAt'] = [DateTime]::UtcNow.ToString('o')
        $taskMetadata | ConvertTo-Json | Set-Content -LiteralPath $taskMetadataPath -Encoding utf8
    }
    if ($taskLockHeld) { $taskMutex.ReleaseMutex() }
    $taskMutex.Dispose()
}
exit $taskExitCode
