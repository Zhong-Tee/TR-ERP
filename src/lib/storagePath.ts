/**
 * Build a Supabase Storage object path without copying the user-supplied
 * filename into the key. The original filename should be stored separately
 * when it needs to be shown to the user.
 */
export function createStoragePath(folder: string, fileName: string): string {
  const extensionMatch = fileName.match(/\.([a-zA-Z0-9]{1,10})$/)
  const extension = extensionMatch ? `.${extensionMatch[1].toLowerCase()}` : ''
  const uniquePart = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  return `${folder}/${uniquePart}${extension}`
}
