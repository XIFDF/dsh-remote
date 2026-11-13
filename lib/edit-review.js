const maxBytes = 64 * 1024
const maxLines = 2000

function reviewable(text) {
  return Buffer.byteLength(text, 'utf8') <= maxBytes
    && !text.includes('\0')
    && text.split('\n', maxLines + 1).length <= maxLines
}

// Reading the before-image for overwrite is best effort. Keep it bounded
// even if the remote file grows between stat and read.
export async function readReviewBefore(sftp, path, decode) {
  try {
    const stat = await sftp.stat(path)
    if ((stat.mode & 0o170000) !== 0o100000 || stat.size > maxBytes) return undefined
    const chunks = []
    for (let offset = 0; offset < stat.size;) {
      const chunk = await sftp.readPartial(path, offset, Math.min(32 * 1024, stat.size - offset))
      if (chunk.length === 0) return undefined
      chunks.push(chunk)
      offset += chunk.length
    }
    const current = await sftp.stat(path)
    if (current.size !== stat.size || current.mtime !== stat.mtime) return undefined
    const text = decode(Buffer.concat(chunks))
    return reviewable(text) ? text : undefined
  } catch (error) {
    if (error.code === 2 || error.code === 'ENOENT') return null
    return undefined
  }
}

export function attachReview(result, path, before, after) {
  if (before === undefined || before === after) return result
  if ((before !== null && !reviewable(before)) || !reviewable(after)) return result
  return { ...result, review: { path, oldText: before, newText: after } }
}

export function reviewOutput(output) {
  return {
    ...output,
    schema: {
      ...output.schema,
      properties: {
        ...output.schema.properties,
        review: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            oldText: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            newText: { type: 'string', required: true },
          },
        },
      },
    },
    presentationMeta: (_args, value) => value.review ? { diffs: [value.review] } : undefined,
  }
}

export function presentRemoteReview(_args, result) {
  if (result.isError || !result.meta?.diffs?.length) return undefined
  const { diffs } = result.meta
  return { card: 'diff', title: `远程改动 · ${diffs[0].path}`, diffs }
}
