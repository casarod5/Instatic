/**
 * CSV parser for site redirects (Phase 1.5, GRAAAAA-69, plan D7).
 *
 * Format:
 *
 *   from,target,status,regex,enabled,note
 *   /old-page,/new-page,301,false,true,Migrated from WordPress
 *   /blog/[year]/[slug],/blog/[slug],308,true,true,Year-prefix catch-all
 *   /promo-2024,https://example.com/promo,302,false,false,Seasonal redirect
 *
 * Required columns: `from`, `target`. Optional: `status` (default 301),
 * `regex` (default false), `enabled` (default true), `note`. Header row is
 * optional — if the first line has no `from` column we treat it as data.
 *
 * Quoted fields with embedded commas / newlines / quotes are supported. We
 * implement a small RFC-4180 subset rather than pulling in a CSV dependency,
 * matching the size discipline of the rest of @core.
 */

export interface ParsedRedirectCsvRow {
  line: number
  from: string
  target: string
  status: string
  regex: string
  enabled: string
  note: string
  raw: Record<string, string>
}

export interface ParsedRedirectCsv {
  rows: ParsedRedirectCsvRow[]
  header: string[]
}

export function parseRedirectsCsv(input: string): ParsedRedirectCsv {
  const rawLines = splitCsvLines(input)
  if (rawLines.length === 0) return { rows: [], header: [] }

  let header = rawLines[0].map((c) => c.toLowerCase().trim())
  let startIndex = 0
  // No header if first row's first cell isn't a recognised column.
  if (header[0] !== 'from') {
    header = ['from', 'target', 'status', 'regex', 'enabled', 'note']
    startIndex = 0
  } else {
    startIndex = 1
  }

  const rows: ParsedRedirectCsvRow[] = []
  for (let i = startIndex; i < rawLines.length; i++) {
    const cells = rawLines[i]
    if (cells.length === 1 && cells[0] === '') continue // blank line
    const raw: Record<string, string> = {}
    header.forEach((column, index) => {
      raw[column] = (cells[index] ?? '').trim()
    })
    rows.push({
      line: i + 1,
      from: raw.from ?? '',
      target: raw.target ?? '',
      status: raw.status ?? '',
      regex: raw.regex ?? '',
      enabled: raw.enabled ?? '',
      note: raw.note ?? '',
      raw,
    })
  }

  return { rows, header }
}

function splitCsvLines(input: string): string[][] {
  const rows: string[][] = []
  let current: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ',') {
      current.push(cell)
      cell = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      // Handle CRLF as a single line break.
      if (char === '\r' && input[i + 1] === '\n') i++
      current.push(cell)
      rows.push(current)
      current = []
      cell = ''
      continue
    }
    cell += char
  }
  // Final cell/row.
  if (cell.length > 0 || current.length > 0) {
    current.push(cell)
    rows.push(current)
  }
  return rows
}
