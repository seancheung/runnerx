# 这个脚本同时支持 Windows PowerShell 5.1 和 PowerShell 7+。
# 不依赖 ConvertTo-Json 处理嵌套数组（5.1 会把 [[a,b],[c,d]] 展平为 [a,b,c,d]），
# 所以 result 协议这一行手动构造 JSON 字符串。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$dir     = $env:RUNNERX_TARGET_DIR
$topN    = [int]($env:RUNNERX_TOP_N)
$recurse = ($env:RUNNERX_RECURSE -eq '1')
$filter  = if ([string]::IsNullOrWhiteSpace($env:RUNNERX_FILTER)) { '*' } else { $env:RUNNERX_FILTER }
$minKB   = [int]($env:RUNNERX_MIN_KB)

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

if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    Emit-Log 'error' "目录不存在: $dir"
    exit 1
}

Emit-Progress 0.05 '开始扫描...'

$gciParams = @{
    LiteralPath = $dir
    File        = $true
    Filter      = $filter
}
if ($recurse) { $gciParams.Recurse = $true }

$files = Get-ChildItem @gciParams -ErrorAction SilentlyContinue
if ($minKB -gt 0) {
    $minBytes = [int64]$minKB * 1024
    $files = $files | Where-Object { $_.Length -ge $minBytes }
}
$files = $files | Sort-Object -Property Length -Descending

$total = ($files | Measure-Object).Count
Emit-Log 'info' "共匹配到 $total 个文件"
Emit-Progress 0.6 '排序完成'

$top = $files | Select-Object -First $topN

$rowParts = New-Object System.Collections.Generic.List[string]
foreach ($f in $top) {
    $name = ConvertTo-JsonStringLiteral $f.FullName
    $sizeText = ConvertTo-JsonStringLiteral ('{0:N2} KB' -f ($f.Length / 1KB))
    $time = ConvertTo-JsonStringLiteral ($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
    [void]$rowParts.Add('[' + $name + ',' + $sizeText + ',' + $time + ']')
}

$rowsJson = '[' + ([string]::Join(',', $rowParts.ToArray())) + ']'
$titleJson = ConvertTo-JsonStringLiteral ("Top $topN 大文件")
$result = '{"type":"table","title":' + $titleJson + ',"columns":["路径","大小","修改时间"],"rows":' + $rowsJson + '}'
Write-Output ('@@runnerx result ' + $result)

# 总大小作为另一种结构化结果
$sumBytes = ($files | Measure-Object -Property Length -Sum).Sum
if ($null -eq $sumBytes) { $sumBytes = 0 }
$sumMB = [math]::Round($sumBytes / 1MB, 2)
$summary = '{"type":"text","label":"汇总","data":' + (ConvertTo-JsonStringLiteral "共 $total 个文件，合计约 $sumMB MB") + '}'
Write-Output ('@@runnerx result ' + $summary)

Emit-Progress 1.0 '完成'
Write-Output "完成。"
