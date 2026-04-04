export default function StatusBar({ isRecording }: { isRecording: boolean }) {
  if (isRecording) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-red-400">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        Recording
      </span>
    )
  }
  return (
    <span className="text-xs text-gray-500">Idle</span>
  )
}
