import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import dotenv from 'dotenv'
import express from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

// 显式按固定路径加载，避免依赖进程 CWD（PM2 可能从 server/ 或根目录启动）。
// dotenv 默认不覆盖已存在的环境变量，因此根目录 .env 优先，server/.env 兜底。
dotenv.config({ path: path.join(ROOT, '.env') })
dotenv.config({ path: path.join(__dirname, '.env') })

const PORT = Number(process.env.PORT || 3001)
const HOST = process.env.HOST || '127.0.0.1'
const NODE_ENV = process.env.NODE_ENV || 'development'

const GLM_API_KEY = process.env.GLM_API_KEY || ''
const GLM_OCR_URL =
  process.env.GLM_OCR_URL || 'https://open.bigmodel.cn/api/paas/v4/layout_parsing'
const GLM_OCR_MODEL = process.env.GLM_OCR_MODEL || 'glm-ocr'

// 单图上限 10MB（GLM-OCR 限制），留一点余量给 base64 膨胀
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const REQUEST_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120_000)

// ---- API Key fail-fast（生产环境不允许缺失或使用占位值）----
if (!GLM_API_KEY) {
  const msg = '[ocr-page] FATAL: 缺少 GLM_API_KEY，请在项目根目录 .env 或 server/.env 中配置'
  if (NODE_ENV === 'production') {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg + '（开发环境继续启动，识别会返回 503）')
}

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)

app.use(
  express.json({
    limit: '14mb',
  })
)

// ---------- 安全响应头 ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // marked 生成的行内样式 + 版面标注需要的 inline style
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

// ---------- 简单滑窗限流（内存）----------
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX = Number(process.env.RATE_MAX || 40)
const buckets = new Map()

function rateLimit(req, res, next) {
  const key = req.ip || 'unknown'
  const now = Date.now()
  const rec = buckets.get(key)

  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 })
    return next()
  }
  rec.count += 1
  if (rec.count > RATE_MAX) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' })
  }
  next()
}

// 定期清理过期桶，避免内存增长
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of buckets) {
    if (now - v.start > RATE_WINDOW_MS) buckets.delete(k)
  }
}, RATE_WINDOW_MS).unref()

// ---------- 前端依赖（本地 vendor，避免依赖 CDN）----------
function serveFromNodeModules(routePath, pkgPath) {
  try {
    const abs = require.resolve(pkgPath)
    app.get(routePath, (req, res) => {
      res.type('application/javascript').sendFile(abs)
    })
    return true
  } catch (err) {
    console.warn(`[ocr-page] 无法定位 ${pkgPath}，${routePath} 将不可用: ${err.message}`)
    return false
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
    // 纯 base64，mime 从 body 取，默认 png
    mime = (typeof body?.mime === 'string' ? body.mime : 'image/png').toLowerCase()
    b64 = raw
  }

  if (!ALLOWED_MIME.has(mime)) {
    return { error: `不支持的图片类型：${mime}（仅支持 PNG / JPEG / WEBP / BMP）` }
  }

  // 去掉空白字符后校验 base64
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

      // 实测上游返回的是像素坐标（并非文档所称的归一化值），需除以页面尺寸。
      // 页面尺寸优先取 block 自带的 width/height，缺失时回退 data_info.pages。
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

// ---------- 路由 ----------
app.get('/health', (req, res) => res.json({ ok: true }))

app.get('/api/info', (req, res) => {
  res.json({
    name: 'ocr-page',
    version: '1.0.0',
    status: GLM_API_KEY ? 'ready' : 'missing_api_key',
    model: GLM_OCR_MODEL,
    max_image_mb: 10,
    features: {
      layout_parsing: true,
      layout_boxes: true,
      camera: false,
    },
  })
})

app.post('/api/ocr', rateLimit, async (req, res) => {
  if (!GLM_API_KEY) {
    return res.status(503).json({ error: '服务端未配置 GLM_API_KEY，无法调用识别服务' })
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
      // 上游错误信息可能含敏感内容，仅记录到服务端日志
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
      console.error('[ocr] GLM 返回非 JSON:', text.slice(0, 500))
      return res.status(502).json({ error: '识别服务返回了无法解析的内容' })
    }

    const layout = normalizeLayout(data.layout_details, data.data_info)

    res.json({
      markdown: data.md_results || '',
      layout,
      layoutVisualization: Array.isArray(data.layout_visualization)
        ? data.layout_visualization
        : [],
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

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' })
})

app.use((err, req, res, next) => {
  // body 超限等
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '图片过大，请压缩后再试' })
  }
  console.error('[server] 未处理异常:', err)
  res.status(500).json({ error: '服务器内部错误' })
})

// ---------- 启动（测试环境不监听端口）----------
if (NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`[ocr-page] listening on http://${HOST}:${PORT} (env=${NODE_ENV})`)
  })
}

export default app
