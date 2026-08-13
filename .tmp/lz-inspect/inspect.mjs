import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool'

const inputPath = 'C:/Users/USER/Downloads/LZ-test13.xlsx'
const input = await FileBlob.load(inputPath)
const workbook = await SpreadsheetFile.importXlsx(input)
const sheets = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 3000 })
console.log('SHEETS')
console.log(sheets.ndjson)

const firstSheet = workbook.worksheets.getItemAt(0)
const used = firstSheet.getUsedRange(true)
console.log('USED_RANGE', used.address)
console.log('A1_L8')
console.log((await workbook.inspect({
  kind: 'table',
  sheetId: firstSheet.name,
  range: 'A1:L8',
  include: 'values,formulas',
  tableMaxRows: 8,
  tableMaxCols: 12,
  maxChars: 12000,
})).ndjson)

console.log('I_COLUMN_DIRECT')
console.log(JSON.stringify({
  values: firstSheet.getRange('I1:I8').values,
  formulas: firstSheet.getRange('I1:I8').formulas,
  displayFormulas: firstSheet.getRange('I1:I8').displayFormulas,
}, null, 2))
