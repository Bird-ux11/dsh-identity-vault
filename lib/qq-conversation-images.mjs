/** Bounded reader for trusted image segments retained from the QQ transport. */
export async function readConversationImage(data, { signal, maxBytes }, io) {
  const check = () => signal?.throwIfAborted();
  const limited = async stream => {
    const chunks = []; let length = 0;
    try {
      for await (const part of stream) {
        check(); const chunk = Buffer.from(part); length += chunk.length;
        if (length > maxBytes) throw Object.assign(new Error('IMAGE_SIZE_LIMIT'), { code: 'IMAGE_SIZE_LIMIT' });
        chunks.push(chunk);
      }
      check(); return Buffer.concat(chunks, length);
    } finally {
      // Node fetch aborts its body on signal; destroy is for local file streams.
      stream?.destroy?.();
    }
  };
  const readLocal = path => limited(io.createReadStream(path, { signal, highWaterMark: 64 * 1024 }));
  const recover = error => { check(); if (error?.code === 'IMAGE_SIZE_LIMIT') throw error; return null; };
  check();
  const d = data || {}, url = typeof d.url === 'string' ? d.url.trim() : '';
  if (url) {
    try {
      if (url.startsWith('file://')) return await readLocal(new URL(url));
      if (/^https?:/i.test(url)) {
        const response = await io.fetch(url, { signal });
        check();
        if (response.ok && response.body) {
          const size = Number(response.headers?.get?.('content-length'));
          if (Number.isFinite(size) && size > maxBytes) {
            await response.body.cancel?.();
            throw Object.assign(new Error('IMAGE_SIZE_LIMIT'), { code: 'IMAGE_SIZE_LIMIT' });
          }
          return await limited(response.body);
        }
        await response.body?.cancel?.();
      }
    } catch (error) { recover(error); }
  }
  const file = typeof d.file === 'string' ? d.file.trim() : '';
  if (file.startsWith('base64://')) {
    const encoded = file.slice(9);
    if (encoded.length > 4 * Math.ceil(maxBytes / 3) + 4) throw Object.assign(new Error('IMAGE_SIZE_LIMIT'), { code: 'IMAGE_SIZE_LIMIT' });
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > maxBytes) throw Object.assign(new Error('IMAGE_SIZE_LIMIT'), { code: 'IMAGE_SIZE_LIMIT' });
    check(); return bytes;
  }
  if (file && (file.includes('\\') || file.includes('/'))) {
    try { return await readLocal(file); } catch (error) { return recover(error); }
  }
  check(); return null;
}
