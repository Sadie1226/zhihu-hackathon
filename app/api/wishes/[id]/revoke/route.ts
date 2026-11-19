import { getDatabase } from '@/lib/db/index'
import { handleWishRevoke } from '@/lib/wishes/contract'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function PATCH(request: Request, context: Context) {
  return handleWishRevoke(request, (await context.params).id, getDatabase)
}
