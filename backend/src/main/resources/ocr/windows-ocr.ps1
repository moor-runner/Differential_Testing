$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stream = $null
$cropPath = $null

function Write-Json($value) {
    [Console]::WriteLine(($value | ConvertTo-Json -Depth 10 -Compress))
}

function Recognize-Lines($decoder, $engine, $originalWidth, $originalHeight, $scale) {
    $ocrBitmap = $null
    try {
        $scaledWidth = [uint32][Math]::Max(1, [Math]::Floor($originalWidth * $scale))
        $scaledHeight = [uint32][Math]::Max(1, [Math]::Floor($originalHeight * $scale))
        $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
        $transform.ScaledWidth = $scaledWidth
        $transform.ScaledHeight = $scaledHeight
        $ocrBitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync(
            [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,
            $transform,
            [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
            [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
        )) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await-WinRt ($engine.RecognizeAsync($ocrBitmap)) ([Windows.Media.Ocr.OcrResult])
        $scaleX = $originalWidth / [double]$scaledWidth
        $scaleY = $originalHeight / [double]$scaledHeight
        $result.Lines | ForEach-Object {
            $line = $_
            $words = @($line.Words | ForEach-Object {
                $rect = $_.BoundingRect
                @{ text = $_.Text; x = $rect.X * $scaleX; y = $rect.Y * $scaleY; width = $rect.Width * $scaleX; height = $rect.Height * $scaleY }
            })
            if ($words.Count -gt 0) {
                $left = ($words | ForEach-Object { $_.x } | Measure-Object -Minimum).Minimum
                $top = ($words | ForEach-Object { $_.y } | Measure-Object -Minimum).Minimum
                $right = ($words | ForEach-Object { $_.x + $_.width } | Measure-Object -Maximum).Maximum
                $bottom = ($words | ForEach-Object { $_.y + $_.height } | Measure-Object -Maximum).Maximum
                @{ text = $line.Text; x = $left; y = $top; width = $right - $left; height = $bottom - $top; words = $words }
            }
        }
    } finally {
        if ($null -ne $ocrBitmap) { $ocrBitmap.Dispose() }
    }
}

function Is-SampleHeading($text) {
    # Unicode escapes keep the bundled script ASCII, including on Windows PowerShell 5.1.
    $normalized = $text -replace '\s', ''
    $sample = '\u6837\u4f8b|\u793a\u4f8b|\u6d4b\u8bd5\u6837\u4f8b'
    $inputOutput = '\u8f93\u5165|\u8f93\u51fa'
    return $normalized -match "^(?:(?:$sample)(?:$inputOutput)?|(?:$inputOutput)(?:$sample)|(?:Sample|Example)(?:Input|Output)?)(?:#?\d+)?[:\uFF1A]?$"
}

function Is-SectionHeading($text) {
    if (Is-SampleHeading $text) { return $true }
    $normalized = $text -replace '\s', ''
    return $normalized -match '^(?:\u9898\u76ee(?:\u63cf\u8ff0|\u80cc\u666f|\u8bf4\u660e)|\u95ee\u9898\u63cf\u8ff0|\u8f93(?:\u5165|\u51fa)(?:\u683c\u5f0f|\u8bf4\u660e|\u63cf\u8ff0)?|(?:\u8f93\u5165)?\u6570\u636e(?:\u8303\u56f4|\u89c4\u6a21)(?:\u4e0e\u7ea6\u5b9a)?|\u9650\u5236|\u7ea6\u675f|\u8bf4\u660e|\u63d0\u793a|\u6ce8\u91ca|Input(?:Format)?|Output(?:Format)?|Constraints|Notes?|Explanation)[:\uFF1A]?$'
}

try {
    $request = [Console]::ReadLine() | ConvertFrom-Json
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
    $awaitMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
        $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await-WinRt($operation, $resultType) {
        $task = $awaitMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
        $task.GetAwaiter().GetResult()
    }

    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
    $preferred = $languages | Where-Object { $_.LanguageTag -like 'zh-Hans*' } | Select-Object -First 1
    if ($null -eq $preferred) { $preferred = $languages | Where-Object { $_.LanguageTag -like 'zh-Hant*' } | Select-Object -First 1 }
    if ($null -eq $preferred) { $preferred = $languages | Where-Object { $_.LanguageTag -like 'en-*' } | Select-Object -First 1 }
    if ($null -eq $preferred) { $preferred = $languages | Select-Object -First 1 }
    $defaultLanguage = if ($null -ne $preferred) { $preferred.LanguageTag } else { '' }
    $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($request.operation -eq 'status') {
        $languageInfo = @($languages | ForEach-Object { @{ tag = $_.LanguageTag; name = $_.DisplayName } })
        Write-Json @{ available = ($languages.Count -gt 0); languages = $languageInfo; defaultLanguage = $defaultLanguage; maxImageDimension = $maxDimension }
        exit 0
    }
    if ($request.operation -ne 'recognize') { throw 'INVALID_REQUEST' }
    if ($languages.Count -eq 0) { Write-Json @{ error = 'NO_LANGUAGE' }; exit 0 }
    if ($request.language) {
        $preferred = $languages | Where-Object { $_.LanguageTag -eq $request.language } | Select-Object -First 1
        if ($null -eq $preferred) { Write-Json @{ error = 'UNSUPPORTED_LANGUAGE' }; exit 0 }
    }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($preferred)
    if ($null -eq $engine) { Write-Json @{ error = 'NO_LANGUAGE' }; exit 0 }

    $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($request.path)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $originalWidth = [int]$decoder.PixelWidth
    $originalHeight = [int]$decoder.PixelHeight
    $ocrWidth = $originalWidth; $ocrHeight = $originalHeight
    $offsetX = 0; $offsetY = 0
    if ($request.regionWidth) {
        $offsetX = [int]$request.regionX; $offsetY = [int]$request.regionY
        $ocrWidth = [int]$request.regionWidth; $ocrHeight = [int]$request.regionHeight
        if ($offsetX -lt 0 -or $offsetY -lt 0 -or $ocrWidth -lt 1 -or $ocrHeight -lt 1 -or
            [long]$offsetX + $ocrWidth -gt $originalWidth -or [long]$offsetY + $ocrHeight -gt $originalHeight) { throw 'INVALID_REGION' }
        # Decode only the problem column at a larger size, then restore its coordinates.
        # The temporary image is created beside this bundled script and always disposed.
        $stream.Dispose(); $stream = $null
        Add-Type -AssemblyName System.Drawing
        Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class ProblemTextPixels {
    public static void Apply(Bitmap bitmap) {
        var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try {
            var pixels = new byte[data.Stride * data.Height];
            Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
            int dark = 0, count = 0;
            for (int i = 0; i < pixels.Length; i += 64) {
                if ((pixels[i] * 114 + pixels[i + 1] * 587 + pixels[i + 2] * 299) / 1000 < 80) dark++;
                count++;
            }
            bool darkBackground = dark > count * 0.6;
            for (int y = 0; y < data.Height; y++) for (int x = 0; x < data.Width; x++) {
                int i = y * data.Stride + x * 4;
                int brightness = (pixels[i] * 114 + pixels[i + 1] * 587 + pixels[i + 2] * 299) / 1000;
                int brightest = Math.Max(pixels[i], Math.Max(pixels[i + 1], pixels[i + 2]));
                byte value = (byte)(darkBackground ? (brightest > 110 ? 255 - brightest : 255) : (brightness < 170 ? brightness : 255));
                pixels[i] = pixels[i + 1] = pixels[i + 2] = value; pixels[i + 3] = 255;
            }
            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
        } finally { bitmap.UnlockBits(data); }
    }
}
'@
        $cropPath = Join-Path $PSScriptRoot ([Guid]::NewGuid().ToString() + '.png')
        $sourceBitmap = [System.Drawing.Bitmap]::new($request.path)
        $cropBitmap = $null
        try {
            $cropBitmap = $sourceBitmap.Clone([System.Drawing.Rectangle]::new($offsetX, $offsetY, $ocrWidth, $ocrHeight), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            [ProblemTextPixels]::Apply($cropBitmap)
            $cropBitmap.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            if ($null -ne $cropBitmap) { $cropBitmap.Dispose() }
            $sourceBitmap.Dispose()
        }
        $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cropPath)) ([Windows.Storage.StorageFile])
        $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    }
    $primaryScale = if ($request.regionWidth) { 1.8 } else { 1.0 }
    $scale = [Math]::Min($primaryScale, [Math]::Min($maxDimension / [double][Math]::Max($ocrWidth, $ocrHeight), [Math]::Sqrt(16000000.0 / ($ocrWidth * [double]$ocrHeight))))
    $lines = @(Recognize-Lines $decoder $engine $ocrWidth $ocrHeight $scale)
    $sampleHeadings = @($lines | Where-Object { Is-SampleHeading $_.text })
    if ($sampleHeadings.Count -gt 0) {
        # A second size can recover short numeric rows that WinRT misses at the original size.
        # It uses the same language, never replaces primary text, and only adds non-overlapping
        # numeric rows inside recognized sample sections. Cap decoding at the upload pixel limit.
        $secondScale = [Math]::Min(1.5, [Math]::Min(
            $maxDimension / [double][Math]::Max($ocrWidth, $ocrHeight),
            [Math]::Sqrt(16000000.0 / ($ocrWidth * [double]$ocrHeight))
        ))
        if ($secondScale -lt $scale * 1.05) { $secondScale = $scale * 0.75 }
        $sampleRanges = @($sampleHeadings | ForEach-Object {
            $heading = $_
            $next = $lines | Where-Object { $_.y -gt $heading.y + $heading.height / 2 -and (Is-SectionHeading $_.text) } | Sort-Object { $_.y } | Select-Object -First 1
            @{ top = $heading.y + $heading.height; bottom = $(if ($null -ne $next) { $next.y } else { $ocrHeight }) }
        })
        try {
            $secondary = @(Recognize-Lines $decoder $engine $ocrWidth $ocrHeight $secondScale)
            foreach ($candidate in $secondary) {
                if ($candidate.text -notmatch '^\s*[-+]?\d[\d\s.,eE+\-]*\s*$') { continue }
                $inSample = @($sampleRanges | Where-Object { $candidate.y -ge $_.top -and $candidate.y + $candidate.height -le $_.bottom }).Count -gt 0
                if (!$inSample) { continue }
                $overlaps = @($lines | Where-Object {
                    $candidate.x -lt $_.x + $_.width + 2 -and $candidate.x + $candidate.width + 2 -gt $_.x -and
                    $candidate.y -lt $_.y + $_.height + 2 -and $candidate.y + $candidate.height + 2 -gt $_.y
                }).Count -gt 0
                if (!$overlaps) { $lines += $candidate }
            }
        } catch {
            # A supplemental pass must not discard a usable primary recognition result.
        }
        $lines = @($lines | Sort-Object { $_.y }, { $_.x })
    }
    if ($request.regionWidth) {
        foreach ($line in $lines) {
            $line.x += $offsetX; $line.y += $offsetY
            foreach ($word in $line.words) { $word.x += $offsetX; $word.y += $offsetY }
        }
    }
    Write-Json @{ width = $originalWidth; height = $originalHeight; language = $engine.RecognizerLanguage.LanguageTag; lines = $lines }
} catch {
    Write-Json @{ error = 'OCR_FAILED' }
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $cropPath -and (Test-Path -LiteralPath $cropPath)) { Remove-Item -LiteralPath $cropPath -Force }
}
