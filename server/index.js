import './env.js'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import express from 'express'

import {
  createUser,
  findUserByUsername,
  findUserById,
  saveHistory,
  getHistoryList,
  getHistoryById,
  deleteHistory,
} from './db.js'
import {
  hashPassword,
  comparePassword,
  signToken,
  requireAuth,
  isProduction,
  getInviteCode,
} from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)


const PORT = Number(process.env.PORT || 3001)
const HOST = process.env.HOST || '127.0.0.1'
const NODE_ENV = process.env.NODE_ENV || 'development'

const GLM_API_KEY = process.env.GLM_API_KEY || ''
const GLM_OCR_URL =
  process.env.GLM_OCR_URL || 'https://open.bigmodel.cn/api/paas/v4/layout_parsing'
const GLM_OCR_MODEL = process.env.GLM_OCR_MODEL || 'glm-ocr'
const INVITE_CODE = getInviteCode()

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const REQUEST_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120_000)

// ---------- fail-fast ----------
if (!GLM_API_KEY) {
  const msg = '[ocr-page] FATAL: 缺少 GLM_API_KEY，请在项目根目录 .env 或 server/.env 中配置'
  if (isProduction()) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg + '（开发环境继续启动，识别会返回 503）')
}

if (!INVITE_CODE) {
  const msg = '[ocr-page] FATAL: 生产环境必须设置 INVITE_CODE（注册邀请码）'
  if (isProduction()) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg + '（开发环境允许开放注册）')
}

if (!process.env.JWT_SECRET) {
  const msg = '[ocr-page] FATAL: 缺少 JWT_SECRET'
  if (isProduction()) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg + '（开发环境将使用临时密钥）')
}

// ---------- Express ----------
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)

app.use(express.json({ limit: '14mb' }))

// 安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  )
  next()
})

// ---------- 限流 ----------
function makeRateLimit(windowMs, max, keyFn) {
  const buckets = new Map()
  const clean = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of buckets) {
      if (now - v.start > windowMs) buckets.delete(k)
    }
  }, windowMs)
  clean.unref()

  return (req, res, next) => {
    const key = keyFn(req)
    if (!key) return next()
    const now = Date.now()
    const rec = buckets.get(key)
    if (!rec || now - rec.start > windowMs) {
      buckets.set(key, { start: now, count: 1 })
      return next()
    }
    rec.count += 1
    if (rec.count > max) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
    }
    next()
  }
}

const authRateLimit = makeRateLimit(10 * 60 * 1000, 20, (req) => req.ip || 'unknown')
const ocrRateLimit = makeRateLimit(
  10 * 60 * 1000,
  Number(process.env.RATE_MAX || 40),
  (req) => String(req.userId || req.ip || 'unknown')
)

// ---------- vendor ----------
function serveFromNodeModules(routePath, pkgPath) {
  try {
    const abs = require.resolve(pkgPath)
    app.get(routePath, (req, res) => {
      res.type('application/javascript').sendFile(abs)
    })
  } catch (err) {
    console.warn(`[ocr-page] 无法定位 ${pkgPath}: ${err.message}`)
  }
}

serveFromNodeModules('/vendor/marked.min.js', 'marked/marked.min.js')
serveFromNodeModules('/vendor/purify.min.js', 'dompurify/dist/purify.min.js')

// ---------- 静态资源 ----------
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }))

// ---------- 工具 ----------
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp'])

function parseImageInput(body) {
  const raw = typeof body?.image === 'string' ? body.image : ''
  if (!raw) return { error: '缺少 image 字段' }

  let mime = ''
  let b64 = ''

  const m = raw.match(/^data:([^;,]+);base64,(.*)$/s)
  if (m) {
    mime = m[1].toLowerCase()
    b64 = m[2]
  } else {
    mime = (typeof body?.mime === 'string' ? body.mime : 'image/png').toLowerCase()
    b64 = raw
  }

  if (!ALLOWED_MIME.has(mime)) {
    return { error: `不支持的图片类型：${mime}（仅支持 PNG / JPEG / WEBP / BMP）` }
  }

  b64 = b64.replace(/\s+/g, '')
  if (!b64) return { error: '图片内容为空' }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { error: '图片数据格式不合法（不是有效的 base64）' }
  }

  const bytes = Math.floor((b64.length * 3) / 4)
  if (bytes > MAX_IMAGE_BYTES) {
    return { error: `图片过大（约 ${(bytes / 1024 / 1024).toFixed(1)}MB），GLM-OCR 单图上限 10MB` }
  }

  return { mime, b64, bytes, dataUri: `data:${mime};base64,${b64}` }
}

function normalizeLayout(layoutDetails, dataInfo) {
  if (!Array.isArray(layoutDetails)) return []

  return layoutDetails.map((pageBlocks, pageIndex) => {
    const dims = dataInfo?.pages?.[pageIndex] || {}
    const pw0 = Number(dims.width) || 0
    const ph0 = Number(dims.height) || 0
    const blocks = Array.isArray(pageBlocks) ? pageBlocks : []

    return blocks.map((b) => {
      let box = Array.isArray(b.bbox_2d) ? b.bbox_2d : null
      const pw = Number(b.width) || pw0
      const ph = Number(b.height) || ph0

      if (box && box.length === 4 && box.every((v) => typeof v === 'number')) {
        const isNormalized = box.every((v) => v >= 0 && v <= 1)
        if (!isNormalized && pw > 0 && ph > 0) {
          box = [box[0] / pw, box[1] / ph, box[2] / pw, box[3] / ph]
        }
        box = box.map((v) => Math.min(1, Math.max(0, v)))
      } else {
        box = null
      }

      return {
        index: b.index ?? null,
        label: b.label || 'text',
        nativeLabel: b.native_label || '',
        bbox: box,
        content: b.content ?? '',
      }
    })
  })
}

function deriveTitle(markdown) {
  const first = markdown.trim().split('\n')[0] || ''
  return first.replace(/^#+\s*/, '').slice(0, 80)
}

// ---------- 公开路由 ----------
app.get('/health', (req, res) => res.json({ ok: true }))

app.get('/api/info', (req, res) => {
  res.json({
    name: 'ocr-page',
    version: '1.0.0',
    status: GLM_API_KEY ? 'ready' : 'missing_api_key',
    model: GLM_OCR_MODEL,
    max_image_mb: 10,
    auth_required: true,
    features: {
      layout_parsing: true,
      layout_boxes: true,
      history: true,
      camera: false,
    },
  })
})

// ---------- 认证路由 ----------
app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const { username, password, inviteCode } = req.body || {}

  if (INVITE_CODE && inviteCode !== INVITE_CODE) {
    return res.status(403).json({ error: '邀请码错误' })
  }

  if (!username || typeof username !== 'string' || username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: '用户名长度 2-32 个字符' })
  }
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$/.test(username)) {
    return res.status(400).json({ error: '用户名只能包含中英文、数字、下划线和短横线' })
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' })
  }

  const existing = findUserByUsername(username)
  if (existing) {
    return res.status(409).json({ error: '用户名已被占用' })
  }

  const passwordHash = await hashPassword(password)
  const user = createUser(username, passwordHash)
  const token = signToken({ userId: user.id, username: user.username })

  res.json({ token, user: { id: user.id, username: user.username } })
})

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: '请填写用户名和密码' })
  }

  const user = findUserByUsername(username)
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const ok = await comparePassword(password, user.password_hash)
  if (!ok) {
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const token = signToken({ userId: user.id, username: user.username })
  res.json({ token, user: { id: user.id, username: user.username } })
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = findUserById(req.userId)
  if (!user) return res.status(401).json({ error: '用户不存在' })
  res.json({ user })
})

// ---------- OCR ----------
app.post('/api/ocr', requireAuth, ocrRateLimit, async (req, res) => {
  if (!GLM_API_KEY) {
    return res.status(503).json({ error: '服务端未配置 GLM_API_KEY' })
  }

  const parsed = parseImageInput(req.body || {})
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const started = Date.now()
  try {
    const upstream = await fetch(GLM_OCR_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GLM_OCR_MODEL,
        file: parsed.dataUri,
      }),
      signal: controller.signal,
    })

    const text = await upstream.text()
    if (!upstream.ok) {
      console.error(`[ocr] GLM 返回 ${upstream.status}: ${text.slice(0, 500)}`)
      return res.status(502).json({
        error: `识别服务返回错误（${upstream.status}）`,
        detail: upstream.status === 429 ? '接口限流，请稍后重试' : undefined,
      })
    }

    let data
    try {
      data = JSON.parse(text)
    } catch {
      return res.status(502).json({ error: '识别服务返回了无法解析的内容' })
    }

    const layout = normalizeLayout(data.layout_details, data.data_info)
    const markdown = data.md_results || ''
    const title = deriveTitle(markdown)

    const historyId = saveHistory(req.userId, {
      title,
      source_image: parsed.dataUri,
      image_width: data.data_info?.pages?.[0]?.width || 0,
      image_height: data.data_info?.pages?.[0]?.height || 0,
      markdown,
      layout_json: JSON.stringify(layout),
      tokens_total: data.usage?.total_tokens || 0,
      elapsed_ms: Date.now() - started,
    })

    res.json({
      id: historyId,
      markdown,
      layout,
      dataInfo: data.data_info || null,
      usage: data.usage || null,
      elapsedMs: Date.now() - started,
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: '识别超时，请稍后重试或换一张更小的图片' })
    }
    console.error('[ocr] 调用失败:', err?.message || err)
    return res.status(502).json({ error: '调用识别服务失败' })
  } finally {
    clearTimeout(timer)
  }
})

// ---------- 历史记录 ----------
app.get('/api/history', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const rows = getHistoryList(req.userId, limit)
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail: r.source_image,
      image_width: r.image_width,
      image_height: r.image_height,
      tokens_total: r.tokens_total,
      elapsed_ms: r.elapsed_ms,
      created_at: r.created_at,
    })),
  })
})

app.get('/api/history/:id', requireAuth, (req, res) => {
  const row = getHistoryById(req.userId, Number(req.params.id))
  if (!row) return res.status(404).json({ error: '记录不存在' })
  res.json({
    id: row.id,
    title: row.title,
    source_image: row.source_image,
    image_width: row.image_width,
    image_height: row.image_height,
    markdown: row.markdown,
    layout: JSON.parse(row.layout_json || '[]'),
    tokens_total: row.tokens_total,
    elapsed_ms: row.elapsed_ms,
    created_at: row.created_at,
  })
})

app.delete('/api/history/:id', requireAuth, (req, res) => {
  const ok = deleteHistory(req.userId, Number(req.params.id))
  if (!ok) return res.status(404).json({ error: '记录不存在' })
  res.json({ ok: true })
})

// ---------- 404 / 错误 ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '图片过大，请压缩后再试' })
  }
  console.error('[server] 未处理异常:', err)
  res.status(500).json({ error: '服务器内部错误' })
})

// ---------- 启动 ----------
if (NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`[ocr-page] listening on http://${HOST}:${PORT} (env=${NODE_ENV})`)
  })
}

export default app
