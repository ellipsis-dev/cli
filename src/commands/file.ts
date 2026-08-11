import { type Command } from 'commander'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ApiClient, ApiError } from '../lib/api'
import { alsoKnownAs, apiRoutes } from '../lib/help'
import { formatTs, printJson, printTable, runAction } from '../lib/output'
import type { CreateFileRequest, FileView, GetFileResponse } from '../lib/types'

// `agent file <verb>`: persist files to Ellipsis platform storage and get back
// an org-membership-gated link. The primary caller is an agent inside a sandbox
// that took a screenshot of a UI change and wants a link to paste into a PR
// comment: the injected sandbox token authenticates it with zero setup, and the
// same commands work on a laptop with a device-login token.

// Client-side mirrors of the server limits (files_service.py), so an
// oversized or non-PNG file fails fast with a clear message instead of a
// base64-inflated round trip to a 400. The server re-validates; these are
// UX, not enforcement.
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Well-known magic bytes we can name in the "not a PNG" error, so an agent
// that screenshotted to the wrong format learns what it actually produced.
const KNOWN_SIGNATURES: Array<[Buffer, string]> = [
  [Buffer.from([0xff, 0xd8, 0xff]), 'JPEG'],
  [Buffer.from('GIF8', 'ascii'), 'GIF'],
  [Buffer.from('BM', 'ascii'), 'BMP'],
  [Buffer.from('%PDF', 'ascii'), 'PDF'],
  [Buffer.from('<svg', 'ascii'), 'SVG'],
  [Buffer.from('<?xm', 'ascii'), 'SVG/XML'],
]

// WebP is RIFF....WEBP — the format tag sits after the chunk size, so it
// doesn't fit the flat prefix table above.
function sniffFormat(bytes: Buffer): string | null {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF') {
    return bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'WebP' : 'RIFF'
  }
  for (const [magic, name] of KNOWN_SIGNATURES) {
    if (bytes.subarray(0, magic.length).equals(magic)) return name
  }
  return null
}

// Build the upload request from a file's bytes, throwing the fast client-side
// errors (empty, oversized, not a PNG). Exported for tests.
export function buildUploadRequest(path: string, bytes: Buffer): CreateFileRequest {
  if (bytes.length === 0) throw new Error(`${path} is empty`)
  if (bytes.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `${path} is ${formatSize(bytes.length)}; the limit is ` +
        `${formatSize(MAX_FILE_SIZE_BYTES)} per file`,
    )
  }
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    const guessed = sniffFormat(bytes)
    throw new Error(
      'only PNG images are supported' +
        (guessed ? ` (got what looks like ${guessed})` : ' (bytes are not a PNG)'),
    )
  }
  return {
    filename: basename(path),
    content_type: 'image/png',
    data_b64: bytes.toString('base64'),
  }
}

// Human-readable byte count for tables and error messages. Binary units to
// match the server's MiB-denominated limits.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function registerFile(program: Command): void {
  const file = alsoKnownAs(
    program
      .command('file')
      .description('Store files on the platform and share them as org-gated links'),
    'files',
    'asset',
    'assets',
  )

  apiRoutes(
    file
      .command('upload <path>')
      .description('Upload a PNG and print its org-gated URL, ready to paste into a PR comment'),
    'POST /files',
  )
    .option('--json', 'output raw JSON')
    .action(async (path: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        const req = buildUploadRequest(path, readFileSync(path))
        const res = await new ApiClient().uploadFile(req)
        // The URL is the whole point — keep it the bare primary output so an
        // agent (or $(...) in a script) can capture it directly.
        if (opts.json) printJson(res)
        else console.log(res.url)
      })
    })

  apiRoutes(
    alsoKnownAs(file.command('list').description('List your stored files, newest first'), 'ls'),
    'GET /files',
  )
    .option('--session <id>', 'only files uploaded by this agent session')
    .option('-l, --limit <n>', 'max results (server cap: 250)', parsePositiveInt)
    .option('--json', 'output raw JSON')
    .action(async (opts: { session?: string; limit?: number; json?: boolean }) => {
      await runAction(async () => {
        const files = await new ApiClient().listFiles({
          agent_session_id: opts.session,
          limit: opts.limit,
        })
        if (opts.json) {
          printJson(files)
          return
        }
        if (files.length === 0) {
          console.log('No files.')
          return
        }
        printTable(
          ['ID', 'FILENAME', 'SIZE', 'CREATED', 'SESSION'],
          files.map((f) => [
            f.id,
            f.filename,
            formatSize(f.size_bytes),
            formatTs(f.created_at),
            f.agent_session_id ?? '-',
          ]),
        )
      })
    })

  apiRoutes(
    file
      .command('get <file-id>')
      .description("Print one file's metadata, or download its bytes with -o"),
    'GET /files/{id}',
    'presigned S3 GET',
  )
    .option('-o, --output <path>', 'write the file contents to this path')
    .option('--json', 'output raw JSON (includes the short-lived download_url)')
    .action(async (fileId: string, opts: { output?: string; json?: boolean }) => {
      await runAction(async () => {
        const res = await new ApiClient().getFile(fileId)
        if (opts.output) {
          // download_url is a ~60s presigned S3 GET — fetch it immediately,
          // while it's fresh. The JSON API never carries the bytes itself.
          await downloadTo(res.download_url, opts.output)
          if (!opts.json) {
            console.log(`✓ wrote ${opts.output} (${formatSize(res.file.size_bytes)})`)
          }
        }
        if (opts.json) printJson(res)
        else if (!opts.output) renderFile(res)
      })
    })

  apiRoutes(
    alsoKnownAs(
      file.command('delete <file-id>').description('Delete a file, so its link stops resolving'),
      'rm',
    ),
    'DELETE /files/{id}',
  )
    .option('--json', 'output raw JSON')
    .action(async (fileId: string, opts: { json?: boolean }) => {
      await runAction(async () => {
        try {
          await new ApiClient().deleteFile(fileId)
        } catch (err) {
          // A 404 covers "never existed", "someone else's", and "already
          // deleted" — all the same "there's nothing here to delete" to the
          // caller, so give one clear message instead of the raw HTTP error.
          if (err instanceof ApiError && err.status === 404) {
            throw new Error(`file not found: ${fileId}`)
          }
          // A 403 is a real policy decision (e.g. sandbox tokens can't delete);
          // surface the server's own explanation rather than masking it.
          if (err instanceof ApiError && err.status === 403) {
            throw new Error(err.detail)
          }
          throw err
        }
        // 204 No Content — nothing to echo, so confirm with the id.
        if (opts.json) printJson({ id: fileId, deleted: true })
        else console.log(`✓ deleted ${fileId}`)
      })
    })
}

function renderFile(res: GetFileResponse): void {
  const f: FileView = res.file
  console.log(`id:        ${f.id}`)
  console.log(`filename:  ${f.filename}`)
  console.log(`type:      ${f.content_type}`)
  console.log(`size:      ${formatSize(f.size_bytes)}`)
  console.log(`created:   ${formatTs(f.created_at)}`)
  if (f.agent_session_id) console.log(`session:   ${f.agent_session_id}`)
  console.log(`url:       ${res.url}`)
  console.log(`\ndownload the file with: agent file get ${f.id} -o ${f.filename}`)
}

// Pull the bytes from the presigned S3 URL. Deliberately bare fetch (no
// bearer header — the signature in the URL is the credential). Files are
// ≤10 MiB, so buffering in memory is fine.
async function downloadTo(url: string, path: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `download failed: ${res.status} ${res.statusText}` +
        (res.status === 403
          ? ' (the presigned URL likely expired — re-run the command for a fresh one)'
          : ''),
    )
  }
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
}

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid count '${raw}'`)
  return n
}
