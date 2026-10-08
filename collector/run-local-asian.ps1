[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('eva', 'vietnam')][string]$Provider,
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot,
    [ValidateRange(30, 270)][int]$TimeoutSeconds = 270
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = Join-Path $env:USERPROFILE ".codex\eee-local-collector\$Provider" }
$taskMutex = [System.Threading.Mutex]::new($false, "Global\EEE.Asian.$Provider.PublicCollector")
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
    $taskCollector = Join-Path $taskRepo 'collector\probe-asian-published-pages.mjs'
    $taskCatalogPath = Join-Path $taskRepo "worker\src\$Provider-published-catalog.json"
    if (-not (Test-Path -LiteralPath $taskCollector -PathType Leaf)) { throw 'Collector script is missing' }
    $taskCatalog = @(Get-Content -LiteralPath $taskCatalogPath -Raw | ConvertFrom-Json)
    $taskApprovedPages = @($taskCatalog | Select-Object -ExpandProperty sourceUrl -Unique)
    if ($taskApprovedPages.Count -lt 1 -or $taskApprovedPages.Count -gt 20) {
        throw 'Local publication coverage needs a refresh feasibility audit'
    }

    $taskOutput = [System.IO.Path]::GetFullPath($OutputRoot)
    if ($taskOutput.Equals($taskRepo, [System.StringComparison]::OrdinalIgnoreCase) -or
        $taskOutput.StartsWith($taskRepo.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Collector output must stay outside the Git repository'
    }
    $taskRunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $taskRunDirectory = Join-Path $taskOutput $taskRunId
    [System.IO.Directory]::CreateDirectory($taskRunDirectory) | Out-Null
    $taskObservationPath = Join-Path $taskRunDirectory "$Provider-published-observations.json"
    $taskMetadataPath = Join-Path $taskRunDirectory 'metadata.json'
    $taskMetadata = [ordered]@{
        source = 'published_page'
        provider = $Provider
        runId = $taskRunId
        startedAt = [DateTime]::UtcNow.ToString('o')
        approvedPages = $taskApprovedPages.Count
        timeoutSeconds = $TimeoutSeconds
        status = 'running'
    }
    $taskMetadata | ConvertTo-Json | Set-Content -LiteralPath $taskMetadataPath -Encoding utf8

    $taskSecretPath = Join-Path $env:USERPROFILE '.codex\secrets\eee-local-collector.dpapi'
    $taskStage = 'loading_credential'
    if (-not (Test-Path -LiteralPath $taskSecretPath -PathType Leaf)) { throw 'Local collector credential is not provisioned' }
    $taskSecureKey = Get-Content -LiteralPath $taskSecretPath -Raw | ConvertTo-SecureString
    $taskSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureKey)
    $taskSecretValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskSecretPointer)
    if ($taskSecretValue -notmatch '^[a-f0-9]{64}$') { throw 'Invalid local collector configuration' }

    $taskStart = [System.Diagnostics.ProcessStartInfo]::new()
    $taskStart.FileName = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $taskStart.WorkingDirectory = $taskRepo
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskStart.ArgumentList.Add($taskCollector)
    $taskStart.Environment['COLLECTOR_KEY'] = $taskSecretValue
    $taskStart.Environment['ASIAN_PUBLIC_PROVIDER'] = $Provider
    $taskStart.Environment['ASIAN_PUBLIC_OFFSET'] = '0'
    $taskStart.Environment['ASIAN_PUBLIC_LIMIT'] = '20'
    $taskStart.Environment['ASIAN_PUBLIC_OUTPUT_DIRECTORY'] = $taskRunDirectory
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
        $taskMetadata['publishedPages'] = $taskPublications.Count
        $taskMetadata['publishedFares'] = [int](($taskPublications | ForEach-Object { $_.publication.published } | Measure-Object -Sum).Sum)
        $taskMetadata['pageErrors'] = @($taskObservations | Where-Object { $null -ne $_.error }).Count
    }
} catch {
    # Keep failure reports independent of decrypted credentials and process environments.
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
