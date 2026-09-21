$docx = (Resolve-Path 'E:\Web_App\TR-ERP\docs\warehouse-stock-verification-manual-th.docx').Path
$outDir = 'E:\Web_App\TR-ERP\.codex_artifacts\stock_manual\rendered'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$pdf = Join-Path $outDir 'warehouse-stock-verification-manual-th.pdf'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $document = $word.Documents.Open($docx, $false, $true)
  $document.ExportAsFixedFormat($pdf, 17)
  $document.Close($false)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null
}
Write-Output $pdf
