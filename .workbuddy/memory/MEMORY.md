# OCR-Page 项目记忆

## 概览

基于智谱 GLM-OCR 的网页版识别工具：粘贴截图 / 拖拽上传 / 拍照 → 调用 OCR → 输出保留排版的 Markdown。

- 本机：`D:\Workbuddy-Project\OCR-Page`
- 仓库：`git@github.com:Beiyouanxiang/OCR-Page.git`（main）
- 服务器：`/data/data_home/xuyifan/OCR-Page`，PM2 `ocr-page`（fork，127.0.0.1:3001）
- 外网：`http://120.25.150.103/ocr/`

## 技术栈

- 后端：Express 5 + 原生 fetch，无构建步骤
- 前端：原生 HTML/CSS/JS；marked + DOMPurify 从 `node_modules` 本地 vendor（不依赖 CDN，国内服务器访问 CDN 不稳）
- 无数据库、无登录

## GLM-OCR 接口（实测结论）

- `POST https://open.bigmodel.cn/api/paas/v4/layout_parsing`
- body：`{ model: "glm-ocr", file: "data:image/png;base64,..." }`
- 返回：`md_results`（Markdown）、`layout_details`、`data_info`、`usage`
- **⚠️ `bbox_2d` 是像素坐标，不是归一化值**（与官方文档不符）。页面尺寸在 block 的 `width/height` 上，`data_info.pages[i]` 也有 —— 归一化时两者都兜底
- 单图 ≤ 10MB；一张普通截图约 400 tokens、1.2s 返回
- 价格 $0.03/百万 tokens，极便宜

## 部署要点

```bash
# 服务器更新
cd /data/data_home/xuyifan/OCR-Page
git fetch origin main && git reset --hard origin/main
npm install --omit=dev
pm2 reload ecosystem.config.cjs
```

- `.env` 需 `GLM_API_KEY`（复用 Bookmark-Page 的即可），生产环境缺失会 `process.exit(1)`
- dotenv **显式按路径加载**（根目录 `.env` + `server/.env`），不依赖 CWD
- 改代码后前端无需构建，reload 即生效（静态文件每次从磁盘读）

## Nginx 子路径挂载（重要）

挂在现有 bookmark 站点下，未新开端口：

```nginx
location = /ocr { return 308 /ocr/; }
location /ocr/ {
    proxy_pass http://127.0.0.1:3001/;   # 末尾 / 剥掉前缀
    client_max_body_size 15m;            # 覆盖 server 级 8m
}
```

两个易踩的坑：
1. **location 里加 `add_header` 会让 server 级安全头全部失效**（nginx 的 add_header 不继承）→ location 内不要写 add_header
2. **`client_max_body_size` 必须在 location 内覆盖**，否则 8m 上限会拦掉 base64 图片（膨胀 33%）

前端因此全部使用**相对路径**，根目录和子路径部署都能用。

## 已知限制

- **摄像头需要 HTTPS 或 localhost**：http 访问时「拍照」按钮自动禁用，粘贴/上传不受影响
- nginx server 级 `Permissions-Policy camera=()` 也会禁用摄像头，需 HTTPS 时再单独放开
- 超大图前端自动缩放长边到 2400px 再上传
