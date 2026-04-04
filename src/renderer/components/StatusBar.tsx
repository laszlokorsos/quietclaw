import { useState, useEffect, useRef } from 'react'
import type { SessionInfo } from '../App'

export default function StatusBar({
  isRecording,
  sessionInfo
}: {
  isRecording: boolean
  sessionInfo: SessionInfo | null
}) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number>(0)

  useEffect(() => {
    if (!isRecording) {
      setElapsed(0)
      return
    }

    // Use the session start time if available, otherwise use now
    startRef.current = sessionInfo?.startTime
      ? new Date(sessionInfo.startTime).getTime()
      : Date.now()

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [isRecording, sessionInfo?.startTime])

  if (isRecording) {
    const mins = Math.floor(elapsed / 60)
    const secs = elapsed % 60
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`

    const title = sessionInfo?.title
    const attendeeCount = sessionInfo?.calendarEvent?.attendees.length

    return (
      <span className="flex items-center gap-1.5 text-xs min-w-0">
        <span className="w-2 h-2 rounded-full bg-recording animate-pulse shrink-0" />
        <span className="text-recording-text shrink-0">{timeStr}</span>
        {title && (
          <>
            <span className="text-text-muted shrink-0">&middot;</span>
            <span className="text-text-primary truncate">{title}</span>
          </>
        )}
        {attendeeCount && attendeeCount > 0 && (
          <span className="text-text-muted shrink-0">
            ({attendeeCount})
          </span>
        )}
      </span>
    )
  }

  return (
    <span className="text-xs text-text-muted">Listening for meetings</span>
  )
}
