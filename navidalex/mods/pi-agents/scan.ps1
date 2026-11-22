# Lists recent sub-agents of Claude Code, Codex and OpenCode as JSON (Pi's are read by the mod).
# Each row: source, id, label, agent, model, cwd, status, createdAt, updatedAt (ms), ref (what the
# viewer opens: a transcript path, or an OpenCode session id).
param([int]$Days = 14)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$since = (Get-Date).AddDays(-$Days)
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$rows = New-Object System.Collections.Generic.List[object]
function Ms($d) { ([DateTimeOffset]$d.ToUniversalTime()).ToUnixTimeMilliseconds() }
function FirstLine($path) {
  $s = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  $r = New-Object IO.StreamReader($s, [Text.Encoding]::UTF8)
  $l = $r.ReadLine(); $r.Close(); return $l
}
# Written in the last 90 s = still running.
function Live($ms) { ($now - $ms) -lt 90000 }

# --- Claude Code: <project>/<session>/subagents/agent-*.jsonl (+ .meta.json) ---
$claude = Join-Path $HOME '.claude\projects'
foreach ($meta in Get-ChildItem -LiteralPath $claude -Recurse -Filter 'agent-*.meta.json' -File | Where-Object { $_.LastWriteTime -gt $since }) {
  $jsonl = $meta.FullName -replace '\.meta\.json$', '.jsonl'
  if (-not (Test-Path -LiteralPath $jsonl)) { continue }
  $m = Get-Content -LiteralPath $meta.FullName -Raw | ConvertFrom-Json
  $file = Get-Item -LiteralPath $jsonl
  $first = FirstLine $jsonl | ConvertFrom-Json
  $updated = Ms $file.LastWriteTime
  $status = if ($m.finished) { 'completed' } elseif (Live $updated) { 'running' } else { 'stopped' }
  $rows.Add([ordered]@{
    source = 'claude'; id = ($meta.BaseName -replace '\.meta$', ''); label = $m.description; agent = $m.agentType
    model = $m.pickedEffortModel; cwd = $first.cwd; status = $status
    createdAt = $(if ($first.timestamp) { Ms ([DateTime]$first.timestamp) } else { Ms $file.CreationTime })
    updatedAt = $updated; ref = $jsonl; parent = $meta.Directory.Parent.Name
  })
}

# --- Codex: rollouts whose session_meta says source.subagent ---
$codex = Join-Path $HOME '.codex\sessions'
foreach ($f in Get-ChildItem -LiteralPath $codex -Recurse -Filter 'rollout-*.jsonl' -File | Where-Object { $_.LastWriteTime -gt $since }) {
  $line = FirstLine $f.FullName
  if (-not $line -or -not $line.Contains('"subagent"')) { continue }
  $p = ($line | ConvertFrom-Json).payload
  $spawn = $p.source.subagent.thread_spawn
  $updated = Ms $f.LastWriteTime
  $rows.Add([ordered]@{
    source = 'codex'; id = $p.id; label = ((@($p.agent_nickname, $p.agent_role) | Where-Object { $_ }) -join ' / ')
    agent = $p.agent_role; model = $p.model_provider; cwd = $p.cwd
    status = $(if (Live $updated) { 'running' } else { 'completed' })
    createdAt = (Ms ([DateTime]$p.timestamp)); updatedAt = $updated; ref = $f.FullName; parent = $spawn.parent_thread_id
  })
}

# --- OpenCode: child sessions in opencode.db (needs sqlite3 on PATH) ---
$db = Join-Path $HOME '.local\share\opencode\opencode.db'
if ((Test-Path -LiteralPath $db) -and (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
  $cut = (Ms $since)
  $q = "select id, parent_id, coalesce(agent,''), coalesce(json_extract(model,'$.id'),''), title, directory, time_created, time_updated from session where parent_id is not null and time_updated > $cut order by time_updated desc limit 200"
  foreach ($l in (& sqlite3 -readonly -separator "`t" $db $q)) {
    $c = $l -split "`t"
    if ($c.Count -lt 8) { continue }
    $updated = [int64]$c[7]
    $rows.Add([ordered]@{
      source = 'opencode'; id = $c[0]; label = $c[4]; agent = $c[2]; model = $c[3]; cwd = $c[5]
      status = $(if (Live $updated) { 'running' } else { 'completed' })
      createdAt = [int64]$c[6]; updatedAt = $updated; ref = $c[0]; parent = $c[1]
    })
  }
}

if ($rows.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $rows.ToArray() -Depth 4 -Compress }
