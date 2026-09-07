# OCR-Page 项目记忆

## 概览

基于智谱 GLM-OCR 的网页版识别工具：**登录后使用**，粘贴截图 / 拖拽上传 → 调用 OCR → 输出保留排版的 Markdown，并**自动保存到个人历史记录**。

- 本机：`D:\Workbuddy-Project\OCR-Page`
- 仓库：`git@github.com:Beiyouanxiang/OCR-Page.git`（main）
- 服务器：`/data/data_home/xuyifan/OCR-Page`，PM2 `ocr-page`（fork，127.0.0.1:3001）
- 外网：`http://120.25.150.103/ocr/`

## 技术栈

- 后端：Express 5 + 原生 fetch
- 数据库：SQLite（`better-sqlite3`），`data/ocr.db`
- 认证：JWT（`jsonwebtoken`）+ bcrypt（`bcryptjs`）
- 前端：原生 HTML/CSS/JS；marked + DOMPurify 从 `node_modules` 本地 vendor（不依赖 CDN）
- 无构建步骤，改完代码 reload 即生效

## 功能

- 登录/注册（邀请码控制注册）
- `Ctrl/⌘ + V` 粘贴截图、拖拽、选择文件
- OCR 保留排版（Markdown 输出）
- 版面标注：元素框 + 点击查看内容
- 个人历史记录自动保存、回看、删除

## GLM-OCR 接口（实测结论）

- `POST https://open.bigmodel.cn/api/paas/v4/layout_parsing`
- body：`{ model: "glm-ocr", file: "data:image/png;base64,..." }`
- 返回：`md_results`（Markdown）、`layout_details`、`data_info`、`usage`
- **⚠️ `bbox_2d` 是像素坐标，不是归一化值**（与官方文档不符）。页面尺寸在 block 的 `width/height` 上，`data_info.pages[i]` 也有 —— 归一化时两者都兜底
- 单图 ≤ 10MB；一张普通截图约 400 tokens、1.2s 返回
- 价格约 0.2 元/百万 tokens

## 环境变量

`.env` 中必须配置：

```env
GLM_API_KEY=...
JWT_SECRET=...          # 生产必须，>=32 字节
INVITE_CODE=...         # 生产必须
PORT=3001
HOST=127.0.0.1
```

## 部署要点

```bash
cd /data/data_home/xuyifan/OCR-Page
git fetch origin main && git reset --hard origin/main
npm install --omit=dev
pm2 reload ecosystem.config.cjs
```

- 首次启动会自动建 SQLite 表
- `data/` 目录权限 700，`ocr.db` 权限 600
- 改代码后前端无需构建，reload 即生效

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

## 关键教训

### dotenv 加载时序（ES module 大坑）

ES module 的静态 import 会先于模块体执行。如果 `auth.js` 里直接检查 `process.env.JWT_SECRET` 并在缺失时 `process.exit(1)`，而它又被 `index.js` 在 `dotenv.config()` 之前 import，则服务启动就自杀。

**解法**：新增 `server/env.js`，内容就是显式 `dotenv.config({path: ...})`，并在 `server/index.js` 第一行 `import './env.js'`。

### Ctrl+V 粘贴图片的兼容性

不能只看 `clipboardData.items`，不同浏览器/工具截图来源不一样。目前兜底三种：
1. `e.clipboardData.files`（最常见）
2. `e.clipboardData.items`（Chrome）
3. `text/html` 里内嵌的 `<img src="data:image/...">`（某些企业 IM/浏览器）

## 已知限制

- 单图 ≤ 10MB、不支持多页 PDF（当前前端只走单图路径）
- 超大图会在前端自动缩放长边到 2400px 后再上传
