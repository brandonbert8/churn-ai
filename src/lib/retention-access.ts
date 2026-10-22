import { timingSafeEqual } from 'node:crypto'
import { dataMode } from '@/mastra/retention/service'

export function accessAllowed(request: Request) {
  if (dataMode() === 'demo') return true
  const expected = process.env.CHURN_APP_TOKEN
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!expected || !supplied) return false
  const a = Buffer.from(expected), b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}
