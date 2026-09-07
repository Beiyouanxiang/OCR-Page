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

  const dropzone = $('dropzone')
  const dropzoneEmpty = $('dropzoneEmpty')
  const previewWrap = $('previewWrap')
  const previewImg = $('previewImg')
  const fileInput = $('fileInput')
  const workCanvas = $('workCanvas')

  const btnPick = $('btnPick')
  const btnCamera = $('btnCamera')
  const btnClear = $('btnClear')
  const btnOcr = $('btnOcr')
  const autoRun = $('autoRun')
  const fileMeta = $('fileMeta')
  const inputError = $('inputError')

  const statusDot = $('statusDot')
  const statusText = $('statusText')
  const resultMeta = $('resultMeta')

  const emptyState = $('emptyState')
  const loadingState = $('loadingState')
  const resultBody = $('resultBody')
  const rendered = $('rendered')
  const rawMarkdown = $('rawMarkdown')
  const layoutStage = $('layoutStage')
  const layoutLegend = $('layoutLegend')

  const btnCopy = $('btnCopy')
  const btnDownloadMd = $('btnDownloadMd')
  const btnDownloadTxt = $('btnDownloadTxt')

  const cameraModal = $('cameraModal')
  const cameraVideo = $('cameraVideo')
  const cameraError = $('cameraError')
  const btnShoot = $('btnShoot')
  const btnSwitchCam = $('btnSwitchCam')
  const btnCloseCamera = $('btnCloseCamera')

  // ---------- 状态 ----------
  const state = {
    prepared: null, // { dataUri, width, height, size, resized }
    result: null,
    busy: false,
    cameraStream: null,
    facing: 'environment',
  }

  // marked UMD 在不同版本下挂载形状不同，做兼容
  const mdParser = (function () {
    const m = window.marked
    if (!m) return null
    if (typeof m.parse === 'function') return m
    if (m.marked && typeof m.marked.parse === 'function') return m.marked
    return null
  })()

  // ---------- 工具 ----------
  function showError(msg) {
    inputError.textContent = msg
    inputError.hidden = false
  }

  function clearError() {
    inputError.hidden = true
    inputError.textContent = ''
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(2) + ' MB'
  }

  function setBusy(busy) {
    state.busy = busy
    btnOcr.disabled = busy || !state.prepared
    btnOcr.textContent = busy ? '识别中…' : '开始识别'
    loadingState.hidden = !busy
    if (busy) {
      emptyState.hidden = true
      resultBody.hidden = true
    }
  }

  function fileToDataUri(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(new Error('读取文件失败'))
      fr.readAsDataURL(file)
    })
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => resolve({ img, url })
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('无法解析该图片文件'))
      }
      img.src = url
    })
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (err) {
        /* 落回 execCommand */
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

  // ---------- 图片预处理 ----------
  async function prepareImage(file) {
    if (!file) throw new Error('没有选择文件')
    if (!/^image\//.test(file.type)) throw new Error('请选择图片文件')

    const { img, url } = await loadImageFromFile(file)
    try {
      const w0 = img.naturalWidth || 0
      const h0 = img.naturalHeight || 0
      if (!w0 || !h0) throw new Error('无法获取图片尺寸')

      const needResize = Math.max(w0, h0) > MAX_SIDE
      const needCompress = file.size > MAX_BYTES

      if (!needResize && !needCompress) {
        const dataUri = await fileToDataUri(file)
        return { dataUri, width: w0, height: h0, size: file.size, resized: false }
      }

      const scale = needResize ? MAX_SIDE / Math.max(w0, h0) : 1
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
    rawMarkdown.textContent = ''
    layoutStage.innerHTML = '<p class="empty-sub">识别后将显示版面标注</p>'
    layoutLegend.hidden = true
    resultMeta.textContent = ''
    btnCopy.disabled = true
    btnDownloadMd.disabled = true
    btnDownloadTxt.disabled = true
    resultBody.hidden = true
    if (!state.busy) emptyState.hidden = false
  }

  // ---------- 识别 ----------
  async function runOcr() {
    if (!state.prepared || state.busy) return
    clearError()
    setBusy(true)

    try {
      const resp = await fetch('api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: state.prepared.dataUri }),
      })

      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        throw new Error(data.error || `识别失败（HTTP ${resp.status}）`)
      }

      state.result = data
      renderResult(data)
      setBusy(false)
      resultBody.hidden = false
      emptyState.hidden = true
    } catch (err) {
      setBusy(false)
      emptyState.hidden = false
      showError(err.message || '识别失败')
    }
  }

  function renderResult(data) {
    const md = data.markdown || ''

    // 排版预览
    if (!md.trim()) {
      rendered.innerHTML = '<p class="empty-sub">这张图片没有识别到文字内容</p>'
    } else if (mdParser) {
      const html = mdParser.parse(md, { gfm: true, breaks: false })
      rendered.innerHTML = window.DOMPurify
        ? window.DOMPurify.sanitize(html)
        : html
    } else {
      rendered.innerHTML = ''
      rendered.textContent = md
    }

    // Markdown 源码
    rawMarkdown.textContent = md

    // 元信息
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

    // 版面标注
    renderLayout(data.layout || [])

    const hasContent = md.trim().length > 0
    btnCopy.disabled = !hasContent
    btnDownloadMd.disabled = !hasContent
    btnDownloadTxt.disabled = !hasContent
  }

  function renderLayout(pages) {
    layoutStage.innerHTML = ''

    const blocks = (pages && pages[0]) || []
    if (!state.prepared || !blocks.length) {
      layoutStage.innerHTML = '<p class="empty-sub">本次识别没有返回版面元素</p>'
      layoutLegend.hidden = true
      return
    }

    layoutLegend.hidden = false

    const img = document.createElement('img')
    img.src = state.prepared.dataUri
    img.alt = '版面标注原图'
    layoutStage.appendChild(img)

    const tip = document.createElement('div')
    tip.className = 'block-tip'
    tip.textContent = '点击任意色块查看该区域识别到的内容'

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
        tip.textContent = `【${label}】\n${b.content || '(无内容)'}`
      })

      layoutStage.appendChild(box)
    })

    // tip 放在 stage 之后（stage 内绝对定位会跟着滚动）
    layoutStage.insertAdjacentElement('afterend', tip)
  }

  // ---------- 拍照 ----------
  function cameraAvailable() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  }

  function stopCamera() {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop())
      state.cameraStream = null
    }
    cameraVideo.srcObject = null
    cameraModal.hidden = true
    cameraError.hidden = true
  }

  async function openCamera() {
    cameraError.hidden = true

    if (!cameraAvailable()) {
      cameraError.textContent =
        '当前环境不支持调用摄像头（浏览器要求 HTTPS 或 localhost 才能访问摄像头）'
      cameraError.hidden = false
      cameraModal.hidden = false
      return
    }

    cameraModal.hidden = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facing, width: { ideal: 1920 } },
        audio: false,
      })
      state.cameraStream = stream
      cameraVideo.srcObject = stream
      await cameraVideo.play().catch(() => {})
    } catch (err) {
      cameraError.textContent = '无法打开摄像头：' + (err.message || err.name)
      cameraError.hidden = false
    }
  }

  function shoot() {
    if (!state.cameraStream) return
    const v = cameraVideo
    const w = v.videoWidth || 1280
    const h = v.videoHeight || 720
    workCanvas.width = w
    workCanvas.height = h
    const ctx = workCanvas.getContext('2d')
    ctx.drawImage(v, 0, 0, w, h)

    workCanvas.toBlob(
      (blob) => {
        if (!blob) {
          cameraError.textContent = '拍照失败，请重试'
          cameraError.hidden = false
          return
        }
        const file = new File([blob], `camera-${stamp()}.jpg`, { type: 'image/jpeg' })
        stopCamera()
        handleFile(file)
      },
      'image/jpeg',
      0.92
    )
  }

  // ---------- 事件绑定 ----------
  dropzone.addEventListener('click', () => {
    if (!state.prepared) fileInput.click()
  })
  dropzone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !state.prepared) {
      e.preventDefault()
      fileInput.click()
    }
  })

  ;['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
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
    const dt = e.dataTransfer
    if (!dt) return
    const file = dt.files && dt.files[0]
    if (file) handleFile(file)
  })

  // 全局粘贴
  document.addEventListener('paste', (e) => {
    if (state.busy) return
    const items = (e.clipboardData && e.clipboardData.items) || []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const file = it.getAsFile()
        if (file) {
          e.preventDefault()
          handleFile(file)
          return
        }
      }
    }
  })

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0]
    if (file) handleFile(file)
  })

  btnPick.addEventListener('click', () => fileInput.click())
  btnCamera.addEventListener('click', openCamera)
  btnClear.addEventListener('click', clearAll)
  btnOcr.addEventListener('click', runOcr)
  btnShoot.addEventListener('click', shoot)
  btnCloseCamera.addEventListener('click', stopCamera)
  btnSwitchCam.addEventListener('click', async () => {
    state.facing = state.facing === 'environment' ? 'user' : 'environment'
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop())
      state.cameraStream = null
    }
    await openCamera()
  })
  cameraModal.addEventListener('click', (e) => {
    if (e.target === cameraModal) stopCamera()
  })

  // Tab 切换
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

  // 复制 / 下载
  btnCopy.addEventListener('click', async () => {
    const md = (state.result && state.result.markdown) || ''
    if (!md) return
    const old = btnCopy.textContent
    const ok = await copyText(md)
    btnCopy.textContent = ok ? '已复制' : '复制失败'
    setTimeout(() => {
      btnCopy.textContent = old
    }, 1500)
  })

  btnDownloadMd.addEventListener('click', () => {
    const md = (state.result && state.result.markdown) || ''
    if (md) download(`ocr-${stamp()}.md`, md, 'text/markdown')
  })

  btnDownloadTxt.addEventListener('click', () => {
    const md = (state.result && state.result.markdown) || ''
    if (md) download(`ocr-${stamp()}.txt`, md, 'text/plain')
  })

  // ---------- 启动 ----------
  if (!cameraAvailable()) {
    btnCamera.disabled = true
    btnCamera.title = '需要 HTTPS 或 localhost 才能调用摄像头'
  }

  ;(async function checkStatus() {
    try {
      const r = await fetch('api/info')
      const d = await r.json()
      if (r.ok && d.status === 'ready') {
        statusDot.classList.add('ok')
        statusText.textContent = `就绪 · ${d.model}`
      } else {
        statusDot.classList.add('err')
        statusText.textContent = '未配置 API Key'
      }
    } catch (err) {
      statusDot.classList.add('err')
      statusText.textContent = '服务不可用'
    }
  })()
})()
