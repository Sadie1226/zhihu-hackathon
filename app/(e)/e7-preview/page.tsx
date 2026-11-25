import { notFound } from 'next/navigation'
import JournalPreview from '@/components/e7/journal-preview'

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <JournalPreview />
}
