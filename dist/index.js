/* dsh-new-session-workspace — host half.
 *
 * The browser half asks which workspace a new conversation should use and, for
 * the "create a new workspace" option, needs a folder to exist before the
 * Workspace Controller will register it. The Host directory seam is the native
 * picker on Windows and macOS, and that capability has no `createDirectory`,
 * so this half exposes the two small same-origin routes the dialog needs.
 */

import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'dsh-new-session-workspace'

const PREPARE_ROUTE = '/dsh-new-session-workspace/prepare'
const HOME_ROUTE = '/dsh-new-session-workspace/home'
const MAX_BODY_BYTES = 16 * 1024

function messageOf(reason) {
  return reason instanceof Error ? reason.message : String(reason)
}

function respond(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

function readJsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        request.destroy()
        reject(new Error('request body too large'))
      }
    })
    request.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {})
      } catch (error) {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

function sameOriginJsonRequest(request) {
  const contentType = (request.headers && request.headers['content-type']) || ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, status: 415, error: 'unsupported-media-type' }
  }
  const origin = request.headers && request.headers.origin
  const host = request.headers && request.headers.host
  if (origin && host) {
    let sameOrigin = false
    try {
      sameOrigin = new URL(origin).host === host
    } catch (error) {
      sameOrigin = false
    }
    if (!sameOrigin) return { ok: false, status: 403, error: 'cross-origin-request' }
  }
  return { ok: true }
}

function validateName(name) {
  const leaf = typeof name === 'string' ? name.trim() : ''
  if (!leaf) return '请输入工作区名称'
  if (leaf === '.' || leaf === '..') return '名称不能是 . 或 ..'
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(leaf)) return '名称不能包含 \\ / : * ? " < > |'
  if (leaf.length > 120) return '名称过长（最多 120 个字符）'
  if (/[. ]$/.test(leaf)) return '名称不能以空格或点结尾'
  return ''
}

async function prepareWorkspace(parent, name) {
  const base = typeof parent === 'string' ? parent.trim() : ''
  if (!base) return { ok: false, status: 400, error: 'is-not-absolute' }
  if (!isAbsolute(base)) return { ok: false, status: 400, error: 'is-not-absolute' }
  const problem = validateName(name)
  if (problem) return { ok: false, status: 400, error: 'invalid-name', detail: problem }
  const target = resolve(join(base, String(name).trim()))
  if (!target || target === resolve(base) || !target.startsWith(resolve(base) + sep)) {
    return { ok: false, status: 400, error: 'invalid-name', detail: '工作区必须位于所选存放位置之内' }
  }
  try {
    await mkdir(target, { recursive: true })
    const info = await stat(target)
    if (!info.isDirectory()) return { ok: false, status: 409, error: 'not-a-directory' }
    return { ok: true, path: target }
  } catch (error) {
    const code = error && error.code ? String(error.code) : ''
    return { ok: false, status: 500, error: 'create-failed', detail: messageOf(error), code }
  }
}

function registerRoutes(sctx) {
  const disposers = []

  disposers.push(sctx.webServer.register({
    kind: 'exact',
    path: HOME_ROUTE,
    handler: (request, response) => {
      if (request.method !== 'POST') return respond(response, 405, { ok: false, error: 'method-not-allowed' })
      const validation = sameOriginJsonRequest(request)
      if (!validation.ok) return respond(response, validation.status, { ok: false, error: validation.error })
      respond(response, 200, { ok: true, home: homedir() })
    }
  }))

  disposers.push(sctx.webServer.register({
    kind: 'exact',
    path: PREPARE_ROUTE,
    handler: async (request, response) => {
      if (request.method !== 'POST') return respond(response, 405, { ok: false, error: 'method-not-allowed' })
      const validation = sameOriginJsonRequest(request)
      if (!validation.ok) return respond(response, validation.status, { ok: false, error: validation.error })
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return respond(response, 400, { ok: false, error: 'bad-request' })
      }
      const result = await prepareWorkspace(body && body.parent, body && body.name)
      if (!result.ok) {
        const status = result.status || 500
        return respond(response, status, result)
      }
      return respond(response, 200, result)
    }
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        /* one stale disposer must not keep the others registered */
      }
    }
  }
}

export function apply(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (sctx) => {
    if (!sctx || !sctx.webServer || typeof sctx.webServer.register !== 'function') return
    const dispose = registerRoutes(sctx)
    if (typeof sctx.effect === 'function') {
      sctx.effect(() => dispose, 'dsh-new-session-workspace: folder routes')
    }
    console.log('[dsh-new-session-workspace] host half loaded; folder routes at ' + PREPARE_ROUTE)
  })
}
