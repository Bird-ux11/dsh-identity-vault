import { createQqConversationRuntime } from './qq-conversation-runtime.mjs';
import { readConversationImage } from './qq-conversation-images.mjs';

const fail = message => { const error = new Error(message); error.reasonCode = 'conversation-contract'; throw error; };
function replaceOnce(source, before, after) {
  if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) fail('QQ conversation adapter anchor changed; source preserved.');
  return source.replace(before, after);
}

/** Called only after the original transport and identity source contracts pass. */
export function patchConversationBridge(input, sourceBuilder) {
  let source = input.replace(/\r\n/g, '\n');
  source = replaceOnce(source, '  // ---------- 挂监听 ----------', `  /* dsh-identity-vault:qq-conversation:v1:begin */
  let 会话调度轮询中 = false
  const 会话调度状态文件 = join(目录, 'qq-conversation-bridge.json')
  const 会话调度 = (${createQqConversationRuntime.toString()})(ctx, {
    readConfig: 读配置, findAgent: 找agent, sessionKey: 会话键, uuid: 新id,
    hashBytes: bytes => createHash('sha256').update(bytes).digest('hex'),
    buildSource: ${sourceBuilder},
    isOwnMessage: id => 己方消息.has(String(id)),
    isArchived: sid => ((ctx.workspaceRegistry?.archivedSessionIds) || []).map(会话键).includes(会话键(sid)),
    loadState() {
      try { return JSON.parse(readFileSync(会话调度状态文件, 'utf8')) }
      catch (error) { if (error?.code !== 'ENOENT') throw error; return { version: 1, events: [], receipts: [] } }
    },
    saveState(state) {
      const serialized = JSON.stringify(state)
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('BRIDGE_STATE_FULL')
      const tmp = 会话调度状态文件 + '.tmp'
      writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, 会话调度状态文件)
    },
    async resolveReference(groupId, messageId) {
      const 配置 = 读配置()
      try {
        const response = await fetch(配置.NapCat + '/get_msg', { method: 'POST', headers: 请求头(配置),
          body: JSON.stringify({ message_id: messageId }), signal: AbortSignal.timeout(5000) })
        const json = await response.json(), raw = json?.status === 'ok' ? json.data : null
        if (!raw || String(raw.group_id || '') !== groupId || !/^[1-9]\\d{4,19}$/.test(String(raw.user_id || raw.sender?.user_id || ''))) return null
        return { authorId: String(raw.user_id || raw.sender.user_id), text: (Array.isArray(raw.message) ? raw.message : [])
          .filter(part => part?.type === 'text').map(part => String(part.data?.text || '')).join('').slice(0, 24000) }
      } catch { return null }
    },
    async prepareImages(row, record, signal) {
      const 配置 = 读配置(), result = []
      if (!配置.收图) return result
      const readImage = ${readConversationImage.toString()}
      const maxBytes = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 8)) * 1024 * 1024
      for (const segment of record.images.slice(0, Math.min(Number(配置.收图最多) || 4, 4))) {
        const bytes = await readImage(segment.data || {}, { signal, maxBytes }, { fetch, createReadStream })
        if (!bytes?.length) continue
        signal.throwIfAborted()
        const mimeType = 看图类(bytes)
        const path = 存一张(record.messageId + '-' + result.length, bytes, mimeType)
        if (path) result.push({ path, mimeType })
      }
      return result
    },
    // The host's attachment admission feeds this Agent's existing multimodal route.
    // No independent vision provider, credentials or model request is introduced.
    async prepareContent(row, record, text, nativeImages) {
      const content = [{ type: 'text', text }]
      if (nativeImages !== undefined) {
        if (!nativeImages.length) return content
        const attachments = ctx.attachments || ctx.get('attachments')
        if (typeof attachments?.admitPromptContent !== 'function') throw new Error('NATIVE_IMAGE_ATTACHMENTS_UNAVAILABLE')
        return attachments.admitPromptContent(content.concat(nativeImages.map(image => ({
          type: 'image', data: Buffer.from(image.data).toString('base64'), mediaType: image.mediaType,
          name: 'qq-' + record.messageId + '.image',
        }))))
      }
      if (!record.images.length || !读配置().收图) return content
      const images = await 会话调度.service.resolveImages({ groupId: record.groupId, messageId: record.messageId })
      if (!images.length) return content
      const attachments = ctx.attachments || ctx.get('attachments')
      if (typeof attachments?.admitPromptContent !== 'function') throw new Error('NATIVE_IMAGE_ATTACHMENTS_UNAVAILABLE')
      return attachments.admitPromptContent(content.concat(images.map(image => ({
        type: 'image', data: readFileSync(image.path).toString('base64'), mediaType: image.mimeType,
        name: 'qq-' + record.messageId + '.image',
      }))))
    },
    async makeSegments(text, images) {
      const 配置 = 读配置(), result = []
      if (text.trim()) result.push({ type: 'text', data: { text } })
      if (images.length && !配置.发图) throw new Error('IMAGES_DISABLED')
      const maxBytes = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
      for (const image of images) {
        let bytes
        if (typeof image === 'string') {
          if (!(/^[a-zA-Z]:[\\\\/]/.test(image) || image.startsWith('/'))) throw new Error('ABSOLUTE_IMAGE_PATH_REQUIRED')
          bytes = readFileSync(image)
        } else {
          if (!image || !(image.data instanceof Uint8Array) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)) throw new Error('INVALID_IMAGE')
          bytes = Buffer.from(image.data)
        }
        if (!bytes.length || bytes.length > Math.min(maxBytes, 8 * 1024 * 1024)) throw new Error('IMAGE_SIZE_LIMIT')
        const signature = bytes.subarray(0, 16).toString('hex')
        if (!(signature.startsWith('89504e470d0a1a0a') || signature.startsWith('ffd8ff') || signature.startsWith('474946383761')
          || signature.startsWith('474946383961') || (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'))) throw new Error('INVALID_IMAGE')
        const detectedType = signature.startsWith('89504e470d0a1a0a') ? 'image/png' : signature.startsWith('ffd8ff') ? 'image/jpeg'
          : signature.startsWith('474946') ? 'image/gif' : 'image/webp'
        if (typeof image !== 'string' && image.mediaType !== detectedType) throw new Error('IMAGE_TYPE_MISMATCH')
        result.push(图片段(bytes.toString('base64')))
      }
      return result
    },
    async send(row, segments) {
      const 配置 = 读配置()
      try {
        const response = await fetch(配置.NapCat + '/send_group_msg', { method: 'POST', headers: 请求头(配置),
          body: JSON.stringify({ group_id: Number(row.号码), message: segments }), signal: AbortSignal.timeout(8000) })
        const result = await response.json(), messageId = result?.data?.message_id ?? result?.data?.messageId
        const ok = Boolean(result?.status === 'ok' && result?.retcode === 0)
        if (ok && messageId != null) 记己方消息(messageId)
        return { ok, messageId, uncertain: result?.retcode === undefined }
      } catch { return { ok: false, uncertain: true } }
    },
  })
  ctx.provide('qqConversationBridge', 会话调度.service)
  ctx.effect(() => () => 会话调度.dispose(), 'identity-vault: qq conversation bridge')
  /* dsh-identity-vault:qq-conversation:v1:end */

  // ---------- 挂监听 ----------`);
  source = replaceOnce(source, '    const 键 = 会话键(session && session.id)\n',
    '    const 键 = 会话键(session && session.id)\n    if (会话调度.ownsSession(键)) return\n');
  source = replaceOnce(source, "      const 这行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === sid) || null\n",
    "      const 这行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === sid) || null\n      if (会话调度.ownsSession(sid)) return { ok: true, 说: '由群对话调度器管理本轮，不执行旧门槛。' }\n");
  source = replaceOnce(source, "        if (行.类型 !== '群') continue     // 私聊不判（自己私聊本来就是在跟它说话）\n",
    "        if (行.类型 !== '群') continue     // 私聊不判（自己私聊本来就是在跟它说话）\n        if (会话调度.ownsGroup(String(行.号码))) continue\n");
  source = replaceOnce(source, '  async function 轮询收消息() {\n',
    '  async function 轮询收消息() {\n    if (会话调度轮询中) return\n    会话调度轮询中 = true\n    try {\n');
  source = replaceOnce(source, '    存水位()\n  }', '    存水位()\n    } finally { 会话调度轮询中 = false }\n  }');
  source = replaceOnce(source, '        if (!条) continue\n', `        if (!条) continue
        if (是群 && 会话调度.selected(String(行.号码))) {
          if ((条.time || 0) < 上次 || 已转消息.has(条.message_id)) continue
          const 接收 = await 会话调度.accept(行, 条, await 条转片段(条), await 拿自己QQ(配置))
          if (接收.exclusive) {
            if (!接收.accepted) break
            已转消息.add(条.message_id)
            上次 = Math.max(上次, 条.time || 上次)
            continue
          }
        }
`);
  // The existing poll API already accepts count. Retain a wider observation window in busy groups.
  source = replaceOnce(source, '? { group_id: Number(行.号码), count: 30 }', '? { group_id: Number(行.号码), count: 会话调度.selected(String(行.号码)) ? 200 : 30 }');
  // The original bridge imports renameSync already only when available in that release.
  if (!/import\s*\{[^}]*\brenameSync\b[^}]*\}\s*from\s*['"]node:fs['"]/.test(source)) {
    source = replaceOnce(source, "from 'node:fs'", "from 'node:fs'");
    source = source.replace(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/, (_whole, names) => `import {${names}, renameSync } from 'node:fs'`);
  }
  source = replaceOnce(source, "import { randomUUID } from 'node:crypto'", "import { randomUUID, createHash } from 'node:crypto'");
  source = source.replace(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/, (_whole, names) => `import {${names}, createReadStream } from 'node:fs'`);
  return input.includes('\r\n') ? source.replace(/\n/g, '\r\n') : source;
}
