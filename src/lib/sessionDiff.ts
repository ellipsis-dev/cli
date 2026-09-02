// Pure shaping for `agent session diff`: the API returns one unified-diff
// section per changed file; stdout gets them back to back, in order, so the
// output is a patch `git apply` reads whole.

export interface PatchFile {
  full_name: string
  path: string
  patch: string
}

export function joinPatches(files: PatchFile[]): string {
  return files.map((f) => (f.patch.endsWith('\n') ? f.patch : `${f.patch}\n`)).join('')
}

// The stderr note for hunks the server dropped to fit its storage cap, so a
// partial patch is never silently partial. Empty when nothing was dropped.
export function omittedNote(paths: string[]): string | null {
  if (paths.length === 0) return null
  return `note: ${paths.length} file${paths.length === 1 ? '' : 's'} omitted (too large to store): ${paths.join(', ')}`
}
