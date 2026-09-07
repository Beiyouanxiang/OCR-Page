# OCR-Page

基于**智谱 GLM-OCR** 的网页版文字识别工具：登录后使用，粘贴截图或上传图片，识别结果保留原始排版并自动保存到个人历史记录。

## 特性

- **登录使用**：用户名 + 密码 + 邀请码注册/登录，识别记录隔离保存
- **粘贴截图**：`Ctrl/⌘ + V` 直接粘贴截图，拖拽或选择文件也可
- **保留排版**：GLM-OCR 返回结构化 Markdown，标题/段落/列表/表格/公式层级都保留
- **版面标注**：把识别到的每个版面元素（文本 / 表格 / 公式 / 图片）用彩色框画回原图，点击可查看该区域内容
- **个人历史**：每次识别自动保存，可随时回看、复制、下载
- **本地渲染**：marked + DOMPurify 均从 `node_modules` 本地提供，不依赖任何 CDN
- **便宜**：GLM-OCR 输入输出同价，约 0.2 元 / 百万 tokens，一张普通截图约 400 tokens

## 本地运行

```bash
npm install
cp .env.example .env      # 填入 GLM_API_KEY / JWT_SECRET / INVITE_CODE
npm start                 # http://127.0.0.1:3001
```

环境变量：
- `GLM_API_KEY`：从 <https://open.bigmodel.cn> 获取
- `JWT_SECRET`：用于签发登录 token，生产环境必须设置且长度 ≥ 32
- `INVITE_CODE`：注册邀请码，生产环境必须设置

## 部署（阿里云 ECS + PM2）

```bash
# 首次
cd /data/data_home/xuyifan/OCR-Page
git clone git@github.com:Beiyouanxiang/OCR-Page.git .
npm install --omit=dev
cp .env.example .env && vi .env        # 填入 GLM_API_KEY / JWT_SECRET / INVITE_CODE
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
    return 308 /ocr/;
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
| POST | `/api/auth/register` | 注册 `{ username, password, inviteCode }` |
| POST | `/api/auth/login` | 登录 `{ username, password }` |
| GET | `/api/auth/me` | 当前用户信息（需登录） |
| GET | `/api/info` | 服务状态、模型名（不暴露密钥） |
| POST | `/api/ocr` | 识别图片（需登录），自动保存历史 |
| GET | `/api/history` | 历史列表（需登录） |
| GET | `/api/history/:id` | 单条历史详情（需登录） |
| DELETE | `/api/history/:id` | 删除历史（需登录） |

`/api/ocr` 返回：

```json
{
  "id": 1,
  "markdown": "## 标题\n\n正文…",
  "layout": [[{ "label": "text", "bbox": [0.08, 0.10, 0.35, 0.15], "content": "…" }]],
  "usage": { "total_tokens": 394 },
  "elapsedMs": 701
}
```

`layout[page][i].bbox` 是**归一化坐标**（0–1，相对原图宽高），方便直接在图上画框。

## 数据

- 数据库：`data/ocr.db`（SQLite WAL 模式）
- 历史记录中的图片以 base64 data URI 形式存储
- 首次启动会自动建表

## 安全

- API Key 只存在于服务端，前端永远拿不到
- JWT 登录态，token 7 天过期
- 限流：默认每用户每 10 分钟 40 次 OCR
- 图片大小限制 10MB（GLM-OCR 单图上限），超限返回 400
- 上游错误信息只写入服务端日志，不透传给前端
- 安全响应头 + CSP（`script-src 'self'`，无内联脚本）

## 已知限制

- 单图 ≤ 10MB、不支持多页 PDF（当前前端只走单图路径）
- 超大图会在前端自动缩放长边到 2400px 后再上传，兼顾识别精度与请求体积
