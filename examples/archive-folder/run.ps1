# Windows 入口：用 PowerShell 的 Compress-Archive 打包目录。
# Compress-Archive 没有 stream 进度回调，所以这里只能在前后报粗粒度的 progress；
# 真正的全文件级进度需要走 .NET ZipArchive API（见底部注释）。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src           = $env:RUNNERX_SOURCE_DIR
$dst           = $env:RUNNERX_OUT_ARCHIVE
$includeHidden = ($env:RUNNERX_INCLUDE_HIDDEN -eq '1')
$compression   = if ([string]::IsNullOrWhiteSpace($env:RUNNERX_COMPRESSION)) { 'optimal' } else { $env:RUNNERX_COMPRESSION }

function ConvertTo-JsonStringLiteral {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '"'  { [void]$sb.Append('\"');  break }
            '\'  { [void]$sb.Append('\\');  break }
            "`b" { [void]$sb.Append('\b');  break }
            "`f" { [void]$sb.Append('\f');  break }
            "`n" { [void]$sb.Append('\n');  break }
            "`r" { [void]$sb.Append('\r');  break }
            "`t" { [void]$sb.Append('\t');  break }
            default {
                $code = [int]$ch
                if ($code -lt 0x20) {
                    [void]$sb.Append(('\u{0:x4}' -f $code))
                } else {
                    [void]$sb.Append($ch)
                }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Emit-Log {
    param([string]$Level, [string]$Message)
    $msg = ConvertTo-JsonStringLiteral $Message
    Write-Output ('@@runnerx log {"level":"' + $Level + '","message":' + $msg + '}')
}

function Emit-Progress {
    param([double]$Value, [string]$Message = '')
    $val = [math]::Round($Value, 4)
    $msg = ConvertTo-JsonStringLiteral $Message
    Write-Output ('@@runnerx progress {"value":' + $val + ',"message":' + $msg + '}')
}

if (-not (Test-Path -LiteralPath $src -PathType Container)) {
    Emit-Log 'error' "源目录不存在: $src"
    exit 1
}

if (Test-Path -LiteralPath $dst) {
    Remove-Item -LiteralPath $dst -Force
}

Emit-Progress 0.05 '收集文件清单...'
$gciParams = @{ LiteralPath = $src; Recurse = $true; File = $true }
if ($includeHidden) { $gciParams.Force = $true }
$files = Get-ChildItem @gciParams -ErrorAction SilentlyContinue
if (-not $includeHidden) {
    # 排除路径中任意一段以点开头的隐藏目录 / 文件
    $files = $files | Where-Object {
        -not ($_.FullName.Substring($src.Length) -match '[\\/]\.')
    }
}
$total = ($files | Measure-Object).Count
Emit-Log 'info' "共 $total 个文件待压缩"

$compLevel = switch ($compression) {
    'fastest'        { 'Fastest' }
    'nocompression'  { 'NoCompression' }
    default          { 'Optimal' }
}

Emit-Progress 0.3 "调用 Compress-Archive (level=$compLevel)..."
if ($includeHidden) {
    Compress-Archive -LiteralPath $src -DestinationPath $dst -CompressionLevel $compLevel -Force
} else {
    # -LiteralPath 无法一次性过滤隐藏文件；改成把目录里的可见文件按相对路径数组传入
    if ($files.Count -eq 0) {
        # 至少建立一个空 zip
        Compress-Archive -LiteralPath $src -DestinationPath $dst -CompressionLevel $compLevel -Force
    } else {
        $paths = @($files | ForEach-Object { $_.FullName })
        Compress-Archive -LiteralPath $paths -DestinationPath $dst -CompressionLevel $compLevel -Force
    }
}

Emit-Progress 1.0 '完成'

$sizeBytes = (Get-Item -LiteralPath $dst).Length
$sizeKB = [math]::Round($sizeBytes / 1KB, 2)
Emit-Log 'info' "输出: $dst ($sizeKB KB)"

$resultJson = '{"type":"file","path":' + (ConvertTo-JsonStringLiteral $dst) + ',"label":"压缩文件"}'
Write-Output ('@@runnerx result ' + $resultJson)

# 备注：如果想要更细粒度的逐文件进度，可以替换 Compress-Archive 为：
#   Add-Type -Assembly System.IO.Compression.FileSystem
#   $zip = [System.IO.Compression.ZipFile]::Open($dst, 'Create')
#   foreach ($f in $files) { ... CreateEntryFromFile + emit progress ... }
#   $zip.Dispose()
