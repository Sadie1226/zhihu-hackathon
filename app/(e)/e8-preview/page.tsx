import { notFound } from 'next/navigation'
import CirclePreview from '@/components/e8/circle-preview'
export default function Page() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <CirclePreview />
}
