Describe 'TokensRank Task Scheduler contract' {
  BeforeAll {
    $script:ScriptRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
    $script:Installer = Join-Path $script:ScriptRoot 'install.ps1'
    $script:Source = Get-Content -LiteralPath $script:Installer -Raw
  }

  It 'registers the TokensRank scheduled task' {
    $script:Source | Should -Match 'Register-ScheduledTask'
    $script:Source | Should -Match "\`$Script:TaskName = 'TokensRank'"
  }

  It 'uses an hourly recurrence trigger' {
    $script:Source | Should -Match 'New-ScheduledTaskTrigger -Once'
    $script:Source | Should -Match 'RepetitionInterval \(New-TimeSpan -Hours 1\)'
  }

  It 'enables StartWhenAvailable for catch-up' {
    $script:Source | Should -Match 'StartWhenAvailable'
    $script:Source | Should -Match 'New-ScheduledTaskSettingsSet'
  }

  It 'runs as the current interactive user rather than SYSTEM' {
    $script:Source | Should -Match 'WindowsIdentity\]::GetCurrent\(\)\.Name'
    $script:Source | Should -Match 'New-ScheduledTaskPrincipal -UserId \$currentUser -LogonType Interactive -RunLevel Limited'
    $script:Source | Should -Match '-Principal \$principal'
  }

  It 'is idempotent by unregistering existing task and registering with Force' {
    $script:Source | Should -Match 'Get-ScheduledTask -TaskName \$Script:TaskName'
    $script:Source | Should -Match 'Unregister-ScheduledTask -TaskName \$Script:TaskName -Confirm:\$false'
    $script:Source | Should -Match 'Register-ScheduledTask .* -Force'
  }

  It 'includes a startup trigger for reboot catch-up' {
    $script:Source | Should -Match 'New-ScheduledTaskTrigger -AtStartup'
    $script:Source | Should -Match '\$startupTrigger'
  }

  It 'executes the installed PowerShell mutex wrapper' {
    $script:Source | Should -Match "New-ScheduledTaskAction -Execute 'powershell.exe'"
    $script:Source | Should -Match 'tokensrank\.ps1'
    $script:Source | Should -Match '--scan-home'
    $script:Source | Should -Match 'Global\\TokensRankSync'
  }
}
