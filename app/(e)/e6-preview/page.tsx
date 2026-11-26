import { notFound } from 'next/navigation'
import MailboxPreview from '@/components/e6/mailbox-preview'
export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <MailboxPreview />
}
