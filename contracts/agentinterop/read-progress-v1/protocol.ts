/** Optional host-only extension of v1/v2 CallToolResult._meta, not an edit capability. */
export type ReadProgress = {
  source:
    | {
        kind: 'working-copy'
        path: string
        sessionId: string
        documentEpoch: string
        revision: number
      }
    | { kind: 'disk'; path: string; sha256: string; extractor: string }
  scope: 'document' | 'body-blocks'
  unit: 'block' | 'line' | 'page'
  from: number
  to: number
  total: number
  hasMore: boolean
  contentComplete: boolean
  nextCursor?: string
}
