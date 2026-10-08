[CmdletBinding()]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot = (Join-Path $env:USERPROFILE '.codex\eee-local-collector\aegean'),
    [string]$TripsJson = '[{"origin":"TLV","destination":"ATH","departDate":"2027-06-01","returnDate":"2027-06-05"}]',
    [ValidateRange(30, 270)][int]$TimeoutSeconds = 270
)

$ErrorActionPreference = 'Stop'
$taskMutex = [System.Threading.Mutex]::new($false, 'Global\EEE.Aegean.HttpCalendarCollector')
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
    $taskCollector = Join-Path $taskRepo 'collector\probe-aegean-http-calendar.mjs'
    if (-not (Test-Path -LiteralPath $taskCollector -PathType Leaf)) { throw 'Collector script is missing' }

    $taskStage = 'validating_trip_selection'
    $taskTrips = ConvertFrom-Json -InputObject $TripsJson -NoEnumerate
    if ($taskTrips -isnot [System.Array] -or $taskTrips.Count -lt 1 -or $taskTrips.Count -gt 12) {
        throw 'Local collection requires one to twelve selected trips'
    }
    $taskTripSelections = [System.Collections.Generic.List[object]]::new()
    $taskTripKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($taskTrip in $taskTrips) {
        if ($null -eq $taskTrip -or $taskTrip -isnot [pscustomobject] -or
            (@('TLV:ATH', 'ATH:TLV') -cnotcontains "$($taskTrip.origin):$($taskTrip.destination)")) {
            throw 'Unsupported selected Aegean route'
        }
        $taskDepartDate = [DateTime]::MinValue
        $taskReturnDate = [DateTime]::MinValue
        if ($taskTrip.departDate -isnot [string] -or $taskTrip.returnDate -isnot [string] -or
            $taskTrip.departDate -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or $taskTrip.returnDate -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or
            -not [DateTime]::TryParseExact($taskTrip.departDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$taskDepartDate) -or
            -not [DateTime]::TryParseExact($taskTrip.returnDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$taskReturnDate) -or
            $taskDepartDate -lt [DateTime]::UtcNow.Date -or $taskReturnDate -le $taskDepartDate) {
            throw 'Invalid selected Aegean dates'
        }
        $taskTripKey = "$($taskTrip.origin)|$($taskTrip.destination)|$($taskTrip.departDate)|$($taskTrip.returnDate)"
        if (-not $taskTripKeys.Add($taskTripKey)) { throw 'Duplicate selected Aegean trip' }
        $taskTripSelections.Add([pscustomobject][ordered]@{
            origin = $taskTrip.origin
            destination = $taskTrip.destination
            departDate = $taskTrip.departDate
            returnDate = $taskTrip.returnDate
        })
    }
    $taskSelectedTripsJson = ConvertTo-Json -InputObject $taskTripSelections.ToArray() -Depth 4 -Compress

    $taskOutput = [System.IO.Path]::GetFullPath($OutputRoot)
    if ($taskOutput.Equals($taskRepo, [System.StringComparison]::OrdinalIgnoreCase) -or
        $taskOutput.StartsWith($taskRepo.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Collector output must stay outside the Git repository'
    }
    $taskRunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $taskRunDirectory = Join-Path $taskOutput $taskRunId
    [System.IO.Directory]::CreateDirectory($taskRunDirectory) | Out-Null
    $taskObservationPath = Join-Path $taskRunDirectory 'aegean-http-calendar-observations.json'
    $taskMetadataPath = Join-Path $taskRunDirectory 'metadata.json'
    $taskMetadata = [ordered]@{
        source = 'aegean_http_calendar'
        runId = $taskRunId
        startedAt = [DateTime]::UtcNow.ToString('o')
        selectedTrips = $taskTripSelections.Count
        timeoutSeconds = $TimeoutSeconds
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
    $taskStart.Environment['AEGEAN_HTTP_TRIPS'] = $taskSelectedTripsJson
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
    $taskMetadata['status'] = if ($taskTimedOut) { 'timed_out' } elseif ($taskExitCode -eq 0) { 'succeeded' } else { 'failed' }
    $taskMetadata['exitCode'] = $taskExitCode
    if (Test-Path -LiteralPath $taskObservationPath -PathType Leaf) {
        $taskStage = 'reading_receipts'
        $taskObservations = @(Get-Content -LiteralPath $taskObservationPath -Raw | ConvertFrom-Json)
        $taskPublications = @($taskObservations | Where-Object { $null -ne $_.publication })
        $taskMetadata['publishedTrips'] = $taskPublications.Count
        $taskMetadata['publishedFares'] = [int](($taskPublications | ForEach-Object { $_.publication.published } | Measure-Object -Sum).Sum)
        $taskMetadata['tripErrors'] = @($taskObservations | Where-Object { $null -ne $_.error }).Count
    }
    if ($taskExitCode -eq 0) {
        if ($taskMetadata['publishedTrips'] -ne $taskTripSelections.Count -or
            $taskMetadata['publishedFares'] -ne $taskTripSelections.Count -or $taskMetadata['tripErrors'] -ne 0) {
            throw 'Selected trip publication is incomplete'
        }
        foreach ($taskObservation in $taskObservations) {
            if ($taskObservation.publication.published -ne 1 -or
                $taskObservation.publication.checkedAt -cne $taskObservation.checkedAt) {
                throw 'Selected trip publication receipt mismatch'
            }
        }
    }
} catch {
    # Failure metadata never includes decrypted credentials or process environments.
    if ($null -ne $taskMetadata) {
        $taskMetadata['status'] = 'failed'
        $taskMetadata['exitCode'] = 1
        $taskMetadata['error'] = 'Local collector could not complete; inspect the bounded collector output'
        $taskMetadata['failureStage'] = $taskStage
    }
    [Console]::Error.WriteLine("Local collector failed during $taskStage.")
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
