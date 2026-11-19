import { getDatabase } from '@/lib/db/index'
import { handleWishCreate, handleWishList } from '@/lib/wishes/contract'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  return handleWishList(request, (await context.params).id, getDatabase)
}
export async function POST(request: Request, context: Context) {
  return handleWishCreate(request, (await context.params).id, getDatabase)
}
