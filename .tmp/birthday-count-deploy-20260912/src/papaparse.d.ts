declare module 'papaparse' {
  export interface ParseError {
    message: string
    row?: number
  }

  export interface ParseResult<T> {
    data: T[]
    errors: ParseError[]
  }

  export function parse<T = unknown>(input: string, config?: { skipEmptyLines?: boolean }): ParseResult<T>
  export function unparse(data: unknown[]): string

  const Papa: {
    parse: typeof parse
    unparse: typeof unparse
  }
  export default Papa
}
