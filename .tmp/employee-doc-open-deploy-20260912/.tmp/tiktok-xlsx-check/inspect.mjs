import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool'

const inputPath = 'C:/Users/USER/Downloads/TT เทส 2 .xlsx'
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath))

const sheets = await workbook.inspect({ kind: 'sheet', include: 'id,name', maxChars: 3000 })
console.log('SHEETS')
console.log(sheets.ndjson)

const data = await workbook.inspect({
  kind: 'table',
  sheetId: 'OrderSKUList',
  range: 'A1:AZ8',
  include: 'values,formulas',
  tableMaxRows: 8,
  tableMaxCols: 52,
  tableMaxCellChars: 120,
  maxChars: 20000,
})
console.log('DATA')
console.log(data.ndjson)
