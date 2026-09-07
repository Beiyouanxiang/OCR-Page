# OCR-Page

基于**智谱 GLM-OCR** 的网页版文字识别工具。粘贴截图、拖拽图片或直接用摄像头拍照，识别后保留原始排版输出 Markdown。

## 特性

- **三种输入**：`Ctrl/⌘ + V` 直接粘贴截图、拖拽/选择文件、调用摄像头拍照
- **保留排版**：GLM-OCR 返回结构化 Markdown，标题/段落/列表/表格/公式层级都保留
- **版面标注**：把识别到的每个版面元素（文本 / 表格 / 公式 / 图片）用彩色框画回原图，点击可查看该区域内容
- **本地渲染**：marked + DOMPurify 均从 `node_modules` 本地提供，不依赖任何 CDN
- **便宜**：GLM-OCR 输入输出同价，$0.03 / 百万 tokens，一张普通截图约 400 tokens

## 本地运行

```bash
npm install
cp .env.example .env      # 填入 GLM_API_KEY
npm start                 # http://127.0.0.1:3001
```

`GLM_API_KEY` 从 <https://open.bigmodel.cn> 获取。生产环境下缺失该变量服务会拒绝启动。

## 部署（阿里云 ECS + PM2）

```bash
# 首次
cd /data/data_home/xuyifan/OCR-Page
git clone git@github.com:Beiyouanxiang/OCR-Page.git .
npm install --omit=dev
cp .env.example .env && vi .env        # 填入 GLM_API_KEY
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save

# 后续更新
git fetch origin main
git reset --hard origin/main
npm install --omit=dev
pm2 reload ecosystem.config.cjs
```

### Nginx 反代

应用内部全部使用**相对路径**（`style.css`、`app.js`、`api/ocr`），所以挂在根路径或子路径下都能工作，无需改代码。

推荐挂在现有 80 端口站点的 `/ocr/` 下（不用新开防火墙端口），把 `deploy/nginx-ocr.conf` 里的两个 location 放进现有 server 块：

```nginx
location = /ocr {
    return 301 /ocr/;
}

location /ocr/ {
    proxy_pass http://127.0.0.1:3001/;   # 末尾的 / 会剥掉 /ocr/ 前缀
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 15m;            # base64 后体积膨胀约 33%
    proxy_read_timeout 180s;
}
```

访问地址：`http://120.25.150.103/ocr/`

需要独立端口时，`deploy/nginx-ocr.conf` 里也提供了监听 8081 的完整 server 块（需安全组放行）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/info` | 服务状态、模型名（不暴露密钥） |
| POST | `/api/ocr` | 识别图片，body: `{ "image": "data:image/png;base64,..." }` |

`/api/ocr` 返回：

```json
{
  "markdown": "## 标题\n\n正文…",
  "layout": [[{ "label": "text", "bbox": [0.08, 0.10, 0.35, 0.15], "content": "…" }]],
  "usage": { "total_tokens": 394 },
  "elapsedMs": 701
}
```

`layout[page][i].bbox` 是**归一化坐标**（0–1，相对原图宽高），方便直接在图上画框。

## 安全

- API Key 只存在于服务端，前端永远拿不到
- 限流：默认每 IP 每 10 分钟 40 次
- 图片大小限制 10MB（GLM-OCR 单图上限），超限返回 400
- 上游错误信息只写入服务端日志，不透传给前端
- 安全响应头 + CSP（`script-src 'self'`，无内联脚本）

## 已知限制

- **摄像头需要 HTTPS 或 localhost**：浏览器安全策略限制，通过 `http://IP` 访问时「拍照」按钮会自动禁用，粘贴和上传不受影响。启用 HTTPS 后自动可用。
- 单图 ≤ 10MB、不支持多页 PDF（当前前端只走单图路径）
- 超大图会在前端自动缩放长边到 2400px 后再上传，兼顾识别精度与请求体积
