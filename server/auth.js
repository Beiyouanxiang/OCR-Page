import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET
const INVITE_CODE = process.env.INVITE_CODE || ''
const NODE_ENV = process.env.NODE_ENV || 'development'

// ---------- 启动时校验 ----------
if (!JWT_SECRET) {
  const msg = '[auth] FATAL: 缺少 JWT_SECRET'
  if (NODE_ENV === 'production') {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg + '（开发环境将使用临时密钥，重启后 token 失效）')
}

export function getJwtSecret() {
  return JWT_SECRET || 'dev-temp-secret-change-me'
}

export function isProduction() {
  return NODE_ENV === 'production'
}

export function getInviteCode() {
  return INVITE_CODE
}

// ---------- 密码 ----------
export async function hashPassword(password) {
  return bcrypt.hash(password, 10)
}

export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash)
}

// ---------- JWT ----------
export function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret())
  } catch {
    return null
  }
}

// ---------- Express 中间件 ----------
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const decoded = verifyToken(token)

  if (!decoded || !decoded.userId) {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }

  req.userId = decoded.userId
  req.username = decoded.username
  next()
}
