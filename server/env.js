import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 显式从固定路径加载 .env，避免依赖进程 CWD。
// 这个模块必须在 server/index.js 中第一个 import，确保后续模块都能读到环境变量。
dotenv.config({ path: path.join(__dirname, '..', '.env') })
dotenv.config({ path: path.join(__dirname, '.env') })
