/** Convert a File to a base64 string (data-URL prefix stripped) using
 *  FileReader, which avoids the O(n) string concatenation that blocked the
 *  main thread. Shared by the composer's pasted images and the Skills tab's
 *  folder import. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}
