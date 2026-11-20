# Long-running reader: polls Windows media sessions (SMTC), keeps Spotify / browser (YouTube Music) sessions,
# and prints one JSON line to stdout whenever the track / play state / cover art changes.
param(
    [int]$IntervalMs = 1500,
    [int]$Size = 48,
    # Regex over the session's app id. Spotify = desktop app; browsers cover YouTube Music (tab or installed app).
    [string]$Sources = 'Spotify|Chrome|MSEdge|Firefox|Brave|Opera|Vivaldi',
    # When set, the full-size cover is also saved here (the background feature reads it).
    [string]$CoverDir = '',
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # non-ASCII titles (Japanese, accents, ...)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

# PS 5.1 can't await WinRT IAsyncOperation<T> directly - bridge through AsTask<T>.
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $null = $task.Wait(-1)
    $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
    ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$md5 = [System.Security.Cryptography.MD5]::Create()

function Read-Cover($thumbRef) {
    if ($null -eq $thumbRef) { return $null }
    $winStream = Await ($thumbRef.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # PS sees the stream as a bare __ComObject; invoking via reflection performs the interface cast.
    $netStream = $asStreamForRead.Invoke($null, @($winStream))
    $ms = New-Object System.IO.MemoryStream
    $netStream.CopyTo($ms)
    $netStream.Dispose()
    $bytes = $ms.ToArray()
    if ($bytes.Length -eq 0) { return $null }

    # Same cover as last poll: skip the decode.
    $hash = [BitConverter]::ToString($md5.ComputeHash($bytes)).Replace('-', '').ToLower()
    if ($script:coverCache -and $script:coverCache.hash -eq $hash) { return $script:coverCache }

    # Full-size cover for the background; write-then-rename so concurrent windows never see half a file.
    $file = $null
    if ($CoverDir) {
        $ext = if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { 'png' } else { 'jpg' }
        $file = "cover-$hash.$ext"
        $full = Join-Path $CoverDir $file
        if (-not (Test-Path $full)) {
            $tmp = "$full.$PID.tmp"
            [System.IO.File]::WriteAllBytes($tmp, $bytes)
            try { Move-Item -LiteralPath $tmp -Destination $full -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
        }
    }

    # Downscale to Size x Size and hand raw RGB bytes to the extension (palette math lives in TS).
    $ms.Position = 0
    $img = [System.Drawing.Image]::FromStream($ms)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $g.DrawImage($img, 0, 0, $Size, $Size)
    $g.Dispose(); $img.Dispose()

    $rgb = New-Object byte[] ($Size * $Size * 3)
    $i = 0
    for ($y = 0; $y -lt $Size; $y++) {
        for ($x = 0; $x -lt $Size; $x++) {
            $p = $bmp.GetPixel($x, $y)
            $rgb[$i] = $p.R; $rgb[$i + 1] = $p.G; $rgb[$i + 2] = $p.B
            $i += 3
        }
    }
    $bmp.Dispose(); $ms.Dispose()
    $script:coverCache = @{ hash = $hash; pixels = [Convert]::ToBase64String($rgb); file = $file }
    $script:coverCache
}

$last = ''
while ($true) {
    $out = @{ running = $false }
    # Prefer a session that is actually playing; fall back to a paused one so the colors stay put.
    $candidates = @($mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -match $Sources })
    $session = $candidates | Where-Object { $_.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing' } | Select-Object -First 1
    if (-not $session) { $session = $candidates | Select-Object -First 1 }
    if ($session) {
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $cover = $null
        try { $cover = Read-Cover $props.Thumbnail } catch { $cover = $null }
        $playing = ($session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing')

        # Playback position (for syncing the music video). Apps report Position + the time it was measured.
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $posMs = $null; $durMs = $null
        $tl = $session.GetTimelineProperties()
        if ($tl -and $tl.EndTime.TotalMilliseconds -gt 0 -and $tl.LastUpdatedTime.Year -gt 2000) {
            $posMs = $tl.Position.TotalMilliseconds
            if ($playing) { $posMs += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalMilliseconds }
            $posMs = [long][Math]::Round($posMs)
            $durMs = [long]$tl.EndTime.TotalMilliseconds
        }
        $out = @{
            running = $true
            source  = $session.SourceAppUserModelId
            playing = $playing
            positionMs = $posMs
            durationMs = $durMs
            capturedAt = $nowMs
            title   = $props.Title
            artist  = $props.Artist
            album   = $props.AlbumTitle
            coverHash = if ($cover) { $cover.hash } else { $null }
            pixels  = if ($cover) { $cover.pixels } else { $null }
            coverFile = if ($cover) { $cover.file } else { $null }
            size    = $Size
        }
    }
    $key = "$($out.running)|$($out.playing)|$($out.title)|$($out.artist)|$($out.coverHash)"

    # Seek detection: position jumped away from where steady playback would put it.
    $seek = $false
    if ($null -ne $out.positionMs -and $null -ne $script:lastPos) {
        $expected = $script:lastPos + $(if ($script:lastPlaying) { $out.capturedAt - $script:lastAt } else { 0 })
        $seek = [Math]::Abs($out.positionMs - $expected) -gt 3000
    }

    if ($key -ne $last -or $seek) {
        $last = $key
        $script:lastPos = $out.positionMs; $script:lastAt = $out.capturedAt; $script:lastPlaying = $out.playing
        [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    }
    if ($Once) { break }
    Start-Sleep -Milliseconds $IntervalMs
}
