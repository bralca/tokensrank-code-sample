Describe 'TokensRank Windows mutex wrapper' {
  BeforeAll {
    $modulePath = Join-Path $PSScriptRoot 'win-mutex.ps1'
    . $modulePath
  }

  BeforeEach {
    $script:lockResult = $null
  }

  AfterEach {
    if ($script:lockResult -and $script:lockResult.mutex) {
      Release-TokensRankMutex -Mutex $script:lockResult.mutex
      $script:lockResult = $null
    }
  }

  It 'acquires the mutex on the first attempt' {
    $script:lockResult = Acquire-TokensRankMutex

    $script:lockResult.acquired | Should -BeTrue
    $script:lockResult.mutex | Should -Not -BeNullOrEmpty
    $script:lockResult.name | Should -Be 'Global\TokensRankSync'
  }

  It 'rejects a second acquire in the same process' {
    $script:lockResult = Acquire-TokensRankMutex

    { Acquire-TokensRankMutex } | Should -Throw -ExpectedMessage '*Another instance*'
  }

  It 'allows reacquisition after release' {
    $script:lockResult = Acquire-TokensRankMutex
    Release-TokensRankMutex -Mutex $script:lockResult.mutex
    $script:lockResult = $null

    $script:lockResult = Acquire-TokensRankMutex

    $script:lockResult.acquired | Should -BeTrue
    $script:lockResult.mutex | Should -Not -BeNullOrEmpty
  }
}
