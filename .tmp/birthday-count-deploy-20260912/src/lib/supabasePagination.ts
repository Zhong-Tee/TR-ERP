export const SUPABASE_PAGE_SIZE = 1000

type SupabasePageResult<T> = {
  data: T[] | null
  error: unknown | null
}

type SupabaseErrorLike = { message: string; code?: string }

/**
 * Read every PostgREST page. The callback must apply a deterministic order
 * before range() so inserts during a multi-page read cannot reshuffle rows.
 */
export async function fetchAllSupabasePages<T>(
  loadPage: (from: number, to: number) => PromiseLike<SupabasePageResult<T>>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? SUPABASE_PAGE_SIZE, SUPABASE_PAGE_SIZE))
  const maxRows = options.maxRows == null ? Number.POSITIVE_INFINITY : Math.max(0, options.maxRows)
  const rows: T[] = []

  while (rows.length < maxRows) {
    const requested = Math.min(pageSize, maxRows - rows.length)
    const from = rows.length
    const { data, error } = await loadPage(from, from + requested - 1)
    if (error) throw error
    const page = data || []
    rows.push(...page.slice(0, requested))
    if (page.length < requested) break
  }

  return rows
}

/** Result-shaped variant for existing Promise.all loaders. */
export async function fetchAllSupabasePagesResult<T>(
  loadPage: (from: number, to: number) => PromiseLike<SupabasePageResult<T>>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<{ data: T[] | null; error: SupabaseErrorLike | null }> {
  try {
    return { data: await fetchAllSupabasePages(loadPage, options), error: null }
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error) {
      return { data: null, error: error as SupabaseErrorLike }
    }
    return { data: null, error: { message: String(error) } }
  }
}
