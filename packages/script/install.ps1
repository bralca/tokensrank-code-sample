[CmdletBinding()]
param(
  [string[]]$AgentArgs = @('--first-run', '--scan-home')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:ClientVersion = '0.0.1'
$Script:TaskName = 'TokensRank'
$Script:DefaultApiBase = 'https://api.tokensrank.ai'
$Script:IsWindowsHost = if (Get-Variable -Name IsWindows -Scope Global -ErrorAction SilentlyContinue) { $IsWindows } else { $true }
$userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$installDir = if ($env:TOKENSRANK_HOME) { $env:TOKENSRANK_HOME } else { Join-Path $userHome '.tokensrank' }
$binDir = Join-Path $installDir 'bin'
$logDir = Join-Path $installDir 'logs'
$configPath = Join-Path $installDir 'config.json'
$statePath = Join-Path $installDir 'state.json'
$accessKeyPath = Join-Path $installDir 'access-key'
$installLog = Join-Path $logDir 'install.log'
$sourceAgentPath = Join-Path $PSScriptRoot 'bin/agent.mjs'
$installedAgentPath = Join-Path $binDir 'agent.mjs'
$installedWrapperPath = Join-Path $binDir 'tokensrank.ps1'
$installedCmdPath = Join-Path $binDir 'tokensrank.cmd'
$apiBase = if ($env:TOKENSRANK_API_BASE) { $env:TOKENSRANK_API_BASE } else { $Script:DefaultApiBase }
$accessKey = if ($env:TOKENSRANK_ACCESS_KEY) { $env:TOKENSRANK_ACCESS_KEY } elseif ($env:TOKENSRANK_SCRIPT_KEY) { $env:TOKENSRANK_SCRIPT_KEY } else { '' }
$profileHandle = if ($env:TOKENSRANK_PROFILE_HANDLE) { $env:TOKENSRANK_PROFILE_HANDLE } else { '' }
$registerScheduler = if ($env:TOKENSRANK_SKIP_SCHEDULER_REGISTER -eq '1') { $false } else { $true }

function Write-InstallLog {
  param([string]$Message)

  New-Item -Path $logDir -ItemType Directory -Force | Out-Null
  Add-Content -LiteralPath $installLog -Value "[tokensrank-install] $Message"
}

function Set-UserOnlyAcl {
  param([string]$Path)

  if (-not $Script:IsWindowsHost) {
    return
  }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRule($rule)
  }

  # Only directories can propagate permissions to children; file ACLs reject
  # inheritance flags. Both keep a protected, current-user-only access rule.
  $inheritance = if ((Get-Item -LiteralPath $Path).PSIsContainer) {
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  $accessRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    'FullControl',
    $inheritance,
    'None',
    'Allow'
  )
  $acl.AddAccessRule($accessRule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-JsonAtomic {
  param(
    [string]$Path,
    [object]$Value
  )

  $directory = Split-Path -Parent $Path
  New-Item -Path $directory -ItemType Directory -Force | Out-Null
  $tempPath = Join-Path $directory ('.{0}.tmp.{1}.{2}' -f (Split-Path -Leaf $Path), $PID, [guid]::NewGuid().ToString('N'))
  try {
    $json = $Value | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($tempPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
    Set-UserOnlyAcl -Path $tempPath
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
    Set-UserOnlyAcl -Path $Path
  } catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Read-JsonFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-ExistingInstallId {
  $config = Read-JsonFile -Path $configPath
  if ($config -and $config.install_id) {
    return [string]$config.install_id
  }

  $state = Read-JsonFile -Path $statePath
  if ($state -and $state.install_id) {
    return [string]$state.install_id
  }

  return [guid]::NewGuid().ToString()
}

function Get-JsonPropertyValue {
  param(
    [object]$Object,
    [string]$Name,
    [object]$Fallback
  )

  if ($null -ne $Object) {
    $property = $Object.PSObject.Properties[$Name]
    if ($property -and $null -ne $property.Value -and [string]$property.Value -ne '') {
      return $property.Value
    }
  }

  return $Fallback
}

function Initialize-InstallState {
  $installId = Get-ExistingInstallId
  $installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $configExists = Test-Path -LiteralPath $configPath
  $existingConfig = Read-JsonFile -Path $configPath

  $configAccessKey = Get-JsonPropertyValue -Object $existingConfig -Name 'access_key' -Fallback ''
  if ($accessKey) {
    $configAccessKey = $accessKey
  }

  $configProfileHandle = Get-JsonPropertyValue -Object $existingConfig -Name 'profile_handle' -Fallback ''
  if ($profileHandle) {
    $configProfileHandle = $profileHandle
  }

  $configInstalledAt = Get-JsonPropertyValue -Object $existingConfig -Name 'installed_at' -Fallback $installedAt

  $config = [ordered]@{
    access_key = $configAccessKey
    profile_handle = $configProfileHandle
    api_base = $apiBase
    install_id = $installId
    client_version = $Script:ClientVersion
    ingestion_mode = 'script'
    installed_at = $configInstalledAt
  }
  Write-JsonAtomic -Path $configPath -Value $config
  Set-UserOnlyAcl -Path $configPath
  if ($configExists) {
    Write-InstallLog 'Updated config.json with latest install settings'
  } else {
    Write-InstallLog 'Created config.json'
  }

  if ($accessKey) {
    [System.IO.File]::WriteAllText($accessKeyPath, "$accessKey`n", [System.Text.UTF8Encoding]::new($false))
    Set-UserOnlyAcl -Path $accessKeyPath
    Write-InstallLog 'Updated access-key handoff file'
  }

  # Every install resets runtime state so the next sync re-ships every session
  # the user has on disk. Server-side dedup makes this idempotent. Only the
  # install_id is preserved for telemetry continuity across reinstalls.
  $stateExists = Test-Path -LiteralPath $statePath
  $preservedInstallId = $installId
  if ($stateExists) {
    $existingState = Read-JsonFile -Path $statePath
    if ($existingState) {
      $existingId = Get-JsonPropertyValue -Object $existingState -Name 'install_id' -Fallback ''
      if ($existingId) {
        $preservedInstallId = [string]$existingId
      }
    }
  }

  $state = [ordered]@{
    install_id = $preservedInstallId
    access_key_invalid = $false
    last_run_at = $null
    shipped_session_ids = @()
    pending_payloads = @()
  }
  Write-JsonAtomic -Path $statePath -Value $state
  if ($stateExists) {
    Write-InstallLog 'Reset state.json runtime fields (shipped_session_ids, pending_payloads, last_run_at, access_key_invalid); install_id preserved'
  } else {
    Write-InstallLog 'Created state.json'
  }
}

function Install-Agent {
  if (-not (Test-Path -LiteralPath $sourceAgentPath)) {
    throw "agent.mjs not found at $sourceAgentPath"
  }

  Copy-Item -LiteralPath $sourceAgentPath -Destination $installedAgentPath -Force
  Set-UserOnlyAcl -Path $installedAgentPath

  $wrapper = @"
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = `$true)]
  [string[]]`$AgentArgs
)

Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Stop'
`$mutex = [System.Threading.Mutex]::new(`$false, 'Global\TokensRankSync')
`$hasLock = `$false

try {
  `$hasLock = `$mutex.WaitOne(0)
  if (-not `$hasLock) {
    [Console]::Error.WriteLine('[tokensrank-script] Another instance running')
    exit 1
  }

  & node "`$PSScriptRoot\agent.mjs" @AgentArgs
  exit `$LASTEXITCODE
} finally {
  if (`$hasLock) {
    `$mutex.ReleaseMutex()
  }
  `$mutex.Dispose()
}
"@
  [System.IO.File]::WriteAllText($installedWrapperPath, $wrapper, [System.Text.UTF8Encoding]::new($false))
  Set-UserOnlyAcl -Path $installedWrapperPath

  $cmd = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%~dp0tokensrank.ps1"" %*`r`n"
  [System.IO.File]::WriteAllText($installedCmdPath, $cmd, [System.Text.UTF8Encoding]::new($false))
  Set-UserOnlyAcl -Path $installedCmdPath
}

function Register-TokensRankTask {
  if (-not $Script:IsWindowsHost -or -not $registerScheduler) {
    Write-InstallLog 'Task Scheduler registration skipped on this host.'
    return
  }

  # Task Scheduler contract generated dynamically:
  # - TaskName: TokensRank
  # - Triggers: AtStartup plus a one-hour recurrence
  # - Settings: StartWhenAvailable=true, AllowStartIfOnBatteries=true,
  #   DontStopIfGoingOnBatteries=true, MultipleInstances=IgnoreNew
  # - Action: powershell.exe with arguments pointing to the installed mutex wrapper
  # - Principal: current interactive user, never SYSTEM
  # - Registration is idempotent: old task is unregistered before re-registering
  $existingTask = Get-ScheduledTask -TaskName $Script:TaskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Unregister-ScheduledTask -TaskName $Script:TaskName -Confirm:$false
  }

  $escapedWrapper = $installedWrapperPath.Replace('"', '\"')
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$escapedWrapper`" --scan-home"
  $startupTrigger = New-ScheduledTaskTrigger -AtStartup
  $hourlyTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

  Register-ScheduledTask -TaskName $Script:TaskName -Action $action -Trigger @($startupTrigger, $hourlyTrigger) -Settings $settings -Principal $principal -Force | Out-Null
  Write-InstallLog "Registered Task Scheduler task: $($Script:TaskName)"
}

function Invoke-FirstRun {
  if ($env:TOKENSRANK_INSTALL_RUN_FIRST -eq '0') {
    Write-InstallLog 'First run skipped by TOKENSRANK_INSTALL_RUN_FIRST'
    return
  }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedWrapperPath @AgentArgs *>> $installLog
  if ($LASTEXITCODE -ne 0) {
    Write-InstallLog "First run exited with code $LASTEXITCODE; scheduler remains installed."
  }
}

New-Item -Path $binDir -ItemType Directory -Force | Out-Null
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
Set-UserOnlyAcl -Path $installDir
Set-UserOnlyAcl -Path $binDir
Set-UserOnlyAcl -Path $logDir
if (-not (Test-Path -LiteralPath $installLog)) {
  New-Item -Path $installLog -ItemType File -Force | Out-Null
}
Set-UserOnlyAcl -Path $installLog

Initialize-InstallState
Install-Agent
Register-TokensRankTask
Invoke-FirstRun

Write-Output "TokensRank script installed at $installDir"
