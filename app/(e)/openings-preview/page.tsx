import { notFound } from 'next/navigation'
import OpeningsPreview from '@/components/e10/openings-preview'

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <OpeningsPreview />
}
