/* OCR-Page 前端逻辑 */
(function () {
  'use strict'

  // ---------- 常量 ----------
  const MAX_SIDE = 2400 // 超过则缩放长边，兼顾识别精度与请求体积
  const MAX_BYTES = 3 * 1024 * 1024 // 超过则走 canvas 压缩

  const LABEL_TEXT = {
    text: '文本',
    table: '表格',
    formula: '公式',
    image: '图片',
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id)

  // 登录
  const loginScreen = $('loginScreen')
  const loginForm = $('loginForm')
  const loginUsername = $('loginUsername')
  const loginPassword = $('loginPassword')
  const loginInvite = $('loginInvite')
  const inviteField = $('inviteField')
  const loginError = $('loginError')
  const authTabs = document.querySelectorAll('.auth-tab')
  const submitBtn = loginForm.querySelector('button[type="submit"]')

  // 主应用
  const appScreen = $('appScreen')
  const currentUser = $('currentUser')
  const btnLogout = $('btnLogout')
  const btnHistory = $('btnHistory')

  // 输入
  const dropzone = $('dropzone')
  const dropzoneEmpty = $('dropzoneEmpty')
  const previewWrap = $('previewWrap')
  const previewImg = $('previewImg')
  const fileInput = $('fileInput')
  const workCanvas = $('workCanvas')
  const btnPick = $('btnPick')
  const btnClear = $('btnClear')
  const btnOcr = $('btnOcr')
  const autoRun = $('autoRun')
  const keepOriginalSize = $('keepOriginalSize')
  const fileMeta = $('fileMeta')
  const inputError = $('inputError')

  // 结果
  const resultMeta = $('resultMeta')
  const emptyState = $('emptyState')
  const loadingState = $('loadingState')
  const resultBody = $('resultBody')
  const rendered = $('rendered')
  const rawMarkdown = $('rawMarkdown')
  const plainText = $('plainText')
  const layoutStage = $('layoutStage')
  const layoutLegend = $('layoutLegend')
  const blockTip = $('blockTip')
  const btnCopy = $('btnCopy')
  const btnCopyPlain = $('btnCopyPlain')
  const btnDownloadMd = $('btnDownloadMd')
  const btnDownloadTxt = $('btnDownloadTxt')

  // 历史
  const historyDrawer = $('historyDrawer')
  const historyBackdrop = $('historyBackdrop')
  const btnCloseHistory = $('btnCloseHistory')
  const historyList = $('historyList')
  const historyFoot = $('historyFoot')
  const btnLoadMore = $('btnLoadMore')

  // ---------- 状态 ----------
  const state = {
    token: localStorage.getItem('ocr_token') || '',
    user: null,
    authMode: 'login', // 'login' | 'register'
    prepared: null, // { dataUri, width, height, size, resized }
    result: null,
    busy: false,
    historyOffset: 0,
    historyHasMore: true,
  }

  // marked UMD 兼容
  const mdParser = (function () {
    const m = window.marked
    if (!m) return null
    if (typeof m.parse === 'function') return m
    if (m.marked && typeof m.marked.parse === 'function') return m.marked
    return null
  })()

  // ---------- 工具 ----------
  function showToast(msg) {
    let toast = document.querySelector('.toast')
    if (!toast) {
      toast = document.createElement('div')
      toast.className = 'toast'
      document.body.appendChild(toast)
    }
    toast.textContent = msg
    toast.classList.add('is-visible')
    setTimeout(() => toast.classList.remove('is-visible'), 2200)
  }

  function showError(msg) {
    inputError.textContent = msg
    inputError.hidden = false
  }

  function clearError() {
    inputError.hidden = true
    inputError.textContent = ''
  }

  function showLoginError(msg) {
    loginError.textContent = msg
    loginError.hidden = false
  }

  function clearLoginError() {
    loginError.hidden = true
    loginError.textContent = ''
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(2) + ' MB'
  }

  function fmtDate(ts) {
    const d = new Date(ts)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function setBusy(busy) {
    state.busy = busy
    btnOcr.disabled = busy || !state.prepared
    btnOcr.textContent = busy ? '识别中…' : '开始识别'
    btnClear.disabled = busy || !state.prepared
    btnPick.disabled = busy
    fileInput.disabled = busy
    btnHistory.disabled = busy
    dropzone.classList.toggle('is-busy', busy)
    loadingState.hidden = !busy
    if (busy) {
      emptyState.hidden = true
      resultBody.hidden = true
    }
  }

  // ---------- API ----------
  async function api(method, path, body) {
    const opts = {
      method,
      headers: {},
    }
    if (state.token) {
      opts.headers.Authorization = `Bearer ${state.token}`
    }
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }

    const res = await fetch(path, opts)
    const data = await res.json().catch(() => ({}))

    if (res.status === 401) {
      logout()
      throw new Error('登录已过期，请重新登录')
    }
    if (!res.ok) {
      throw new Error(data.error || `请求失败（${res.status}）`)
    }
    return data
  }

  // ---------- 认证 ----------
  function showLogin() {
    loginScreen.hidden = false
    appScreen.hidden = true
    historyDrawer.hidden = true
    loginUsername.value = ''
    loginPassword.value = ''
    loginInvite.value = ''
    clearLoginError()
    setAuthMode('login')
  }

  function showApp() {
    loginScreen.hidden = true
    appScreen.hidden = false
    currentUser.textContent = state.user?.username || '用户'
  }

  function setAuthMode(mode) {
    state.authMode = mode
    authTabs.forEach((t) => t.classList.toggle('is-active', t.dataset.auth === mode))
    if (mode === 'register') {
      inviteField.classList.remove('is-hidden')
      submitBtn.textContent = '注 册'
    } else {
      inviteField.classList.add('is-hidden')
      submitBtn.textContent = '登 录'
    }
    clearLoginError()
  }

  async function initAuth() {
    if (!state.token) {
      showLogin()
      return
    }
    try {
      const data = await api('GET', 'api/auth/me')
      state.user = data.user
      showApp()
      renderHistoryList()
    } catch (err) {
      console.warn('[auth] token 无效:', err.message)
      logout(false)
      showLogin()
    }
  }

  async function handleAuthSubmit(e) {
    e.preventDefault()
    clearLoginError()

    const username = loginUsername.value.trim()
    const password = loginPassword.value
    const inviteCode = loginInvite.value.trim()

    if (!username || !password) {
      showLoginError('请填写用户名和密码')
      return
    }

    try {
      let data
      if (state.authMode === 'login') {
        data = await api('POST', 'api/auth/login', { username, password })
      } else {
        data = await api('POST', 'api/auth/register', { username, password, inviteCode })
      }
      state.token = data.token
      state.user = data.user
      localStorage.setItem('ocr_token', data.token)
      showApp()
      renderHistoryList()
      showToast(state.authMode === 'login' ? '登录成功' : '注册成功')
    } catch (err) {
      showLoginError(err.message)
    }
  }

  function logout(notify = true) {
    state.token = ''
    state.user = null
    localStorage.removeItem('ocr_token')
    clearAll()
    showLogin()
    if (notify) showToast('已退出登录')
  }

  // ---------- 图片处理 ----------
  function fileToDataUri(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('读取文件失败'))
      fr.readAsDataURL(file)
    })
  }

  async function loadImageFromFile(file) {
    const url = URL.createObjectURL(file)
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ img, url })
      img.onerror = async () => {
        URL.revokeObjectURL(url)
        try {
          // 某些剪贴板图片格式（如 Windows DIB、无扩展名图片）
          // HTMLImageElement 无法解码，但 ImageBitmap 通常可以。
          // 用 canvas 重绘一次，转成浏览器一定认识的 PNG。
          const bmp = await createImageBitmap(file)
          const c = document.createElement('canvas')
          c.width = bmp.width
          c.height = bmp.height
          c.getContext('2d').drawImage(bmp, 0, 0)
          bmp.close && bmp.close()
          const dataUri = c.toDataURL('image/png')
          const img2 = new Image()
          img2.onload = () => resolve({ img: img2, url: dataUri })
          img2.onerror = () => reject(new Error('无法解析该图片文件'))
          img2.src = dataUri
        } catch (err) {
          reject(new Error('无法解析该图片文件'))
        }
      }
      img.src = url
    })
  }

  async function prepareImage(file) {
    if (!file) throw new Error('没有选择文件')
    if (!/^image\//.test(file.type)) throw new Error('请选择图片文件')

    const { img, url } = await loadImageFromFile(file)
    try {
      const w0 = img.naturalWidth || 0
      const h0 = img.naturalHeight || 0
      if (!w0 || !h0) throw new Error('无法获取图片尺寸')

      const maxSide = keepOriginalSize.checked ? 8192 : MAX_SIDE
      const needResize = Math.max(w0, h0) > maxSide
      const needCompress = file.size > MAX_BYTES

      if (!needResize && !needCompress) {
        const dataUri = await fileToDataUri(file)
        return { dataUri, width: w0, height: h0, size: file.size, resized: false }
      }

      const scale = needResize ? maxSide / Math.max(w0, h0) : 1
      const w = Math.max(1, Math.round(w0 * scale))
      const h = Math.max(1, Math.round(h0 * scale))

      workCanvas.width = w
      workCanvas.height = h
      const ctx = workCanvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)

      const keepPng = file.type === 'image/png' && !needCompress
      const mime = keepPng ? 'image/png' : 'image/jpeg'
      const dataUri = workCanvas.toDataURL(mime, 0.92)
      const b64len = dataUri.length - dataUri.indexOf(',') - 1
      const size = Math.floor((b64len * 3) / 4)

      return { dataUri, width: w, height: h, size, resized: true }
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  // ---------- 输入处理 ----------
  async function handleFile(file) {
    clearError()
    if (!file) return
    try {
      const prepared = await prepareImage(file)
      state.prepared = prepared

      previewImg.src = prepared.dataUri
      previewWrap.hidden = false
      dropzoneEmpty.hidden = true
      dropzone.classList.add('has-image')

      fileMeta.hidden = false
      fileMeta.textContent = `${prepared.width}×${prepared.height} · ${fmtSize(
        prepared.size
      )}${prepared.resized ? ' · 已压缩' : ''}`

      btnClear.disabled = false
      btnOcr.disabled = state.busy
      clearResult()

      if (autoRun.checked) runOcr()
    } catch (err) {
      showError(err.message || '图片处理失败')
    }
  }

  function clearAll() {
    state.prepared = null
    state.result = null
    previewImg.removeAttribute('src')
    previewWrap.hidden = true
    dropzoneEmpty.hidden = false
    dropzone.classList.remove('has-image')
    fileMeta.hidden = true
    btnClear.disabled = true
    btnOcr.disabled = true
    clearResult()
    clearError()
    fileInput.value = ''
  }

  function clearResult() {
    state.result = null
    rendered.innerHTML = ''
    rawMarkdown.value = ''
    plainText.textContent = ''
    layoutStage.innerHTML = '<p class="empty-sub">识别后将显示版面标注</p>'
    layoutLegend.hidden = true
    blockTip.hidden = true
    blockTip.textContent = ''
    resultMeta.textContent = ''
    btnCopy.disabled = true
    btnCopyPlain.disabled = true
    btnDownloadMd.disabled = true
    btnDownloadTxt.disabled = true
    resultBody.hidden = true
    if (!state.busy) emptyState.hidden = false
  }

  async function getImageFromClipboard(e) {
    const cd = e.clipboardData
    if (!cd) return null

    // 1. 优先从 files 读取（多数截图工具）
    if (cd.files && cd.files.length) {
      for (const f of cd.files) {
        if (/^image\//.test(f.type)) return f
      }
    }

    // 2. 从 items 读取
    if (cd.items) {
      for (const item of cd.items) {
        if (item.kind === 'file' && /^image\//.test(item.type)) {
          const file = item.getAsFile()
          if (file) return file
        }
      }
    }

    // 3. text/html 里可能内嵌了图片
    const html = cd.getData('text/html')
    if (html) {
      // 3a. base64 图片
      const m = html.match(/<img[^>]+src="(data:image\/[^;]+;base64,[^"]+)"/i)
      if (m) {
        try {
          return dataUriToFile(m[1])
        } catch {
          /* ignore */
        }
      }

      // 3b. 网络图片或 blob URL（部分网页/应用复制的是 <img src="https://...">）
      const m2 = html.match(/<img[^>]+src="(https?:\/\/[^"]+|blob:[^"]+)"/i)
      if (m2) {
        try {
          return await urlToFile(m2[1])
        } catch {
          /* ignore */
        }
      }
    }

    // 4. 纯文本里只有 URL
    const plain = cd.getData('text/plain')
    if (plain) {
      const url = plain.trim()
      if (/^https?:\/\/.+/i.test(url)) {
        try {
          return await urlToFile(url)
        } catch {
          /* ignore */
        }
      }
    }

    return null
  }

  function dataUriToFile(dataUri) {
    const m = dataUri.match(/^data:(.+);base64,(.*)$/)
    if (!m) throw new Error('Invalid data URI')
    const byteString = atob(m[2])
    const mime = m[1]
    const ab = new ArrayBuffer(byteString.length)
    const ia = new Uint8Array(ab)
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i)
    const ext = mime.split('/')[1] || 'png'
    return new File([ab], `pasted-${Date.now()}.${ext}`, { type: mime })
  }

  async function urlToFile(url) {
    const resp = await fetch(url, { mode: 'cors' })
    if (!resp.ok) throw new Error('无法下载图片')
    const blob = await resp.blob()
    if (!/^image\//.test(blob.type)) throw new Error('剪贴板 URL 不是图片')
    const ext = blob.type.split('/')[1] || 'png'
    return new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type })
  }

  // ---------- 识别 ----------
  let ocrGen = 0

  async function runOcr() {
    if (!state.prepared || state.busy) return
    const snapshot = state.prepared
    const gen = ++ocrGen
    clearError()
    setBusy(true)

    try {
      const data = await api('POST', 'api/ocr', { image: snapshot.dataUri })
      // 如果识别过程中用户换了图，丢弃过期响应
      if (state.prepared !== snapshot || gen !== ocrGen) {
        console.log('[ocr] 响应已过期，丢弃')
        return
      }
      state.result = data
      renderResult(data)
      setBusy(false)
      resultBody.hidden = false
      emptyState.hidden = true
      renderHistoryList()
    } catch (err) {
      setBusy(false)
      if (gen === ocrGen) {
        emptyState.hidden = false
        showError(err.message || '识别失败')
      }
    }
  }

  function renderResult(data, opts = {}) {
    const md = data.markdown || ''

    if (!md.trim()) {
      rendered.innerHTML = '<p class="empty-sub">这张图片没有识别到文字内容</p>'
    } else if (mdParser) {
      const html = mdParser.parse(md, { gfm: true, breaks: false })
      if (window.DOMPurify) {
        rendered.innerHTML = window.DOMPurify.sanitize(html)
      } else {
        // DOMPurify 缺失时不渲染原始 HTML，退回到纯文本，避免 XSS
        rendered.innerHTML = ''
        rendered.textContent = md
      }
    } else {
      rendered.innerHTML = ''
      rendered.textContent = md
    }

    rawMarkdown.value = md
    plainText.textContent = markdownToPlain(md)

    const bits = []
    if (data.usage && typeof data.usage.total_tokens === 'number') {
      bits.push(`tokens ${data.usage.total_tokens}`)
    }
    if (typeof data.elapsedMs === 'number') {
      bits.push(`${(data.elapsedMs / 1000).toFixed(1)}s`)
    }
    const blocks = (data.layout || []).reduce((n, p) => n + (p ? p.length : 0), 0)
    if (blocks) bits.push(`${blocks} 个版面元素`)
    resultMeta.textContent = bits.join(' · ')

    const sourceImage = opts.source_image || (state.prepared && state.prepared.dataUri)
    renderLayout(data.layout || [], sourceImage)

    const hasContent = md.trim().length > 0
    btnCopy.disabled = !hasContent
    btnCopyPlain.disabled = !hasContent
    btnDownloadMd.disabled = !hasContent
    btnDownloadTxt.disabled = !hasContent
  }

  function renderLayout(pages, sourceImage) {
    layoutStage.innerHTML = ''
    blockTip.hidden = true
    blockTip.textContent = ''

    const blocks = (pages && pages[0]) || []
    if (!sourceImage || !blocks.length) {
      layoutStage.innerHTML = '<p class="empty-sub">本次识别没有返回版面元素</p>'
      layoutLegend.hidden = true
      return
    }

    layoutLegend.hidden = false

    const img = document.createElement('img')
    img.src = sourceImage
    img.alt = '版面标注原图'
    layoutStage.appendChild(img)

    blocks.forEach((b) => {
      if (!b || !Array.isArray(b.bbox) || b.bbox.length !== 4) return
      const [x1, y1, x2, y2] = b.bbox
      const box = document.createElement('div')
      box.className = 'layout-box b-' + (b.label || 'text')
      box.style.left = Math.min(x1, x2) * 100 + '%'
      box.style.top = Math.min(y1, y2) * 100 + '%'
      box.style.width = Math.abs(x2 - x1) * 100 + '%'
      box.style.height = Math.abs(y2 - y1) * 100 + '%'
      box.title = LABEL_TEXT[b.label] || b.label || '元素'

      box.addEventListener('click', () => {
        Array.prototype.forEach.call(
          layoutStage.querySelectorAll('.layout-box.is-active'),
          (el) => el.classList.remove('is-active')
        )
        box.classList.add('is-active')
        const label = LABEL_TEXT[b.label] || b.label || '元素'
        blockTip.textContent = `【${label}】\n${b.content || '(无内容)'}`
        blockTip.hidden = false
      })

      layoutStage.appendChild(box)
    })
  }

  // ---------- 历史记录 ----------
  const HISTORY_PAGE_SIZE = 20

  function createHistoryItem(item) {
    const el = document.createElement('div')
    el.className = 'history-item'
    const thumb = item.thumbnail
      ? `<img class="history-thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />`
      : `<div class="history-thumb" style="background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:11px">无图</div>`
    el.innerHTML = `
      ${thumb}
      <div class="history-body">
        <p class="history-title">${escapeHtml(item.title || '未识别到标题')}</p>
        <p class="history-meta">${fmtDate(item.created_at)} · ${item.tokens_total || 0} tokens · ${
      item.image_width
    }×${item.image_height}</p>
      </div>
      <button class="history-delete" data-id="${item.id}" title="删除">×</button>
    `
    el.addEventListener('click', (e) => {
      if (state.busy) {
        showToast('识别中，请稍后再打开历史')
        return
      }
      if (e.target.classList.contains('history-delete')) {
        e.stopPropagation()
        deleteHistoryItem(item.id)
        return
      }
      loadHistoryItem(item.id)
    })
    return el
  }

  async function renderHistoryList(reset = true) {
    if (!state.user) return
    if (reset) {
      state.historyOffset = 0
      state.historyHasMore = true
      historyList.innerHTML = '<div class="empty-history">加载中…</div>'
    }
    try {
      const data = await api(
        'GET',
        `api/history?limit=${HISTORY_PAGE_SIZE}&offset=${state.historyOffset}`
      )
      const items = data.items || []

      if (reset) {
        historyList.innerHTML = ''
      }

      if (!items.length && state.historyOffset === 0) {
        historyList.innerHTML = '<div class="empty-history">暂无识别记录</div>'
        historyFoot.hidden = true
        return
      }

      items.forEach((item) => {
        historyList.appendChild(createHistoryItem(item))
      })

      state.historyHasMore = items.length === HISTORY_PAGE_SIZE
      state.historyOffset += items.length
      historyFoot.hidden = !state.historyHasMore
    } catch (err) {
      console.error('[history] 加载失败:', err)
      if (reset) {
        historyList.innerHTML = '<div class="empty-history">加载失败</div>'
      }
      historyFoot.hidden = true
    }
  }

  async function loadMoreHistory() {
    if (!state.historyHasMore) return
    await renderHistoryList(false)
  }

  async function loadHistoryItem(id) {
    try {
      const data = await api('GET', `api/history/${id}`)
      state.prepared = {
        dataUri: data.source_image,
        width: data.image_width,
        height: data.image_height,
        size: 0,
        resized: false,
      }
      previewImg.src = data.source_image
      previewWrap.hidden = false
      dropzoneEmpty.hidden = true
      dropzone.classList.add('has-image')
      fileMeta.hidden = false
      fileMeta.textContent = `${data.image_width}×${data.image_height} · 来自历史记录`
      btnClear.disabled = false

      state.result = data
      renderResult(data, { source_image: data.source_image })
      resultBody.hidden = false
      emptyState.hidden = true
      closeHistoryDrawer()
    } catch (err) {
      showToast(err.message || '加载失败')
    }
  }

  async function deleteHistoryItem(id) {
    if (!confirm('确定删除这条记录？')) return
    try {
      await api('DELETE', `api/history/${id}`)
      renderHistoryList()
      showToast('已删除')
    } catch (err) {
      showToast(err.message || '删除失败')
    }
  }

  function openHistoryDrawer() {
    if (state.busy) {
      showToast('识别中，请稍后再打开历史')
      return
    }
    historyDrawer.hidden = false
    renderHistoryList(true)
  }

  function closeHistoryDrawer() {
    historyDrawer.hidden = true
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // 将 Markdown 简单清洗为纯文本（用于复制和 .txt 下载）
  function markdownToPlain(md) {
    return String(md || '')
      .replace(/^#+\s*/gm, '') // 标题标记
      .replace(/\*\*|__/g, '') // 加粗
      .replace(/`/g, '') // 行内代码
      .replace(/^\s*[-*+]\s+/gm, '') // 列表标记
      .replace(/^\s*\d+\.\s+/gm, '') // 有序列表
      .replace(/^\s*>\s?/gm, '') // 引用
      .replace(/^\s*[-=]{3,}\s*$/gm, '') // 分隔线
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 链接 [text](url)
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // 图片
      .replace(/^\|?\s*(.+?)\s*\|?$/gm, (m, c) => c.replace(/\|/g, ' ')) // 表格行转空格分隔
      .replace(/\|\|?/g, ' ') // 剩余表格分隔符
      .replace(/\n{3,}/g, '\n\n') // 多余空行
      .trim()
  }

  // ---------- 复制/下载 ----------
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (err) {
        /* fallback */
      }
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (err) {
      ok = false
    }
    document.body.removeChild(ta)
    return ok
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function stamp() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
      d.getMinutes()
    )}${p(d.getSeconds())}`
  }

  // ---------- 事件绑定 ----------
  authTabs.forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.auth))
  })
  loginForm.addEventListener('submit', handleAuthSubmit)
  btnLogout.addEventListener('click', () => logout())
  btnHistory.addEventListener('click', openHistoryDrawer)
  btnCloseHistory.addEventListener('click', closeHistoryDrawer)
  historyBackdrop.addEventListener('click', closeHistoryDrawer)
  btnLoadMore.addEventListener('click', loadMoreHistory)

  dropzone.addEventListener('click', () => {
    if (!state.prepared && !state.busy) fileInput.click()
  })
  dropzone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !state.prepared && !state.busy) {
      e.preventDefault()
      fileInput.click()
    }
  })

  ;['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      if (state.busy) return
      e.preventDefault()
      dropzone.classList.add('is-dragover')
    })
  })
  ;['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault()
      dropzone.classList.remove('is-dragover')
    })
  })
  dropzone.addEventListener('drop', (e) => {
    if (state.busy) return
    const dt = e.dataTransfer
    if (!dt) return
    const file = dt.files && dt.files[0]
    if (file) handleFile(file)
  })

  // 粘贴：同时绑定 document 和 dropzone，尽量兼容不同浏览器
  async function onPaste(e) {
    if (appScreen.hidden || state.busy) return
    const file = await getImageFromClipboard(e)
    if (file) {
      e.preventDefault()
      handleFile(file)
    }
  }

  document.addEventListener('paste', onPaste)
  dropzone.addEventListener('paste', onPaste)

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0]
    if (file) handleFile(file)
  })

  btnPick.addEventListener('click', () => fileInput.click())
  btnClear.addEventListener('click', clearAll)
  btnOcr.addEventListener('click', runOcr)

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), (tab) => {
    tab.addEventListener('click', () => {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), (t) =>
        t.classList.remove('is-active')
      )
      Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), (p) =>
        p.classList.remove('is-active')
      )
      tab.classList.add('is-active')
      const panel = $('tab' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1))
      if (panel) panel.classList.add('is-active')
    })
  })

  btnCopy.addEventListener('click', async () => {
    const md = rawMarkdown.value || ''
    if (!md) return
    const ok = await copyText(md)
    showToast(ok ? '已复制 Markdown' : '复制失败')
  })

  rawMarkdown.addEventListener('input', () => {
    plainText.textContent = markdownToPlain(rawMarkdown.value || '')
  })

  btnCopyPlain.addEventListener('click', async () => {
    const text = markdownToPlain(rawMarkdown.value || '')
    if (!text) return
    const ok = await copyText(text)
    showToast(ok ? '已复制纯文本' : '复制失败')
  })

  btnDownloadMd.addEventListener('click', () => {
    const md = rawMarkdown.value || ''
    if (md) download(`ocr-${stamp()}.md`, md, 'text/markdown')
  })

  btnDownloadTxt.addEventListener('click', () => {
    const text = markdownToPlain(rawMarkdown.value || '')
    if (text) download(`ocr-${stamp()}.txt`, text, 'text/plain')
  })

  // ---------- 启动 ----------
  initAuth()
})()
