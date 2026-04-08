/**
 * Audio capture utility process — runs audio capture in an isolated process
 * to prevent UI rendering or main-process work from causing audio dropouts.
 *
 * Spawned by capture-macos.ts via electron.utilityProcess.fork().
 * Loads the native audio addon and streams captured audio back to the
 * main process via a transferred MessagePort (zero-copy ArrayBuffer transfer).
 *
 * Protocol:
 *   parentPort messages (control):
 *     Main → Utility: { event: 'start-capture', options, port: MessagePort }
 *     Main → Utility: { event: 'stop-capture' }
 *     Main → Utility: { event: 'flush-temp-file' }
 *     Utility → Main: { event: 'started' | 'stopped' | 'error', message? }
 *
 *   MessagePort messages (audio data, transferred ArrayBuffer):
 *     Utility → Main: { source, buffer: Float32Array, timestamp }
 */

// Native addon path is passed as first argument
const nativeAddonPath = process.argv[2]

if (!nativeAddonPath) {
  process.parentPort.postMessage({ event: 'error', message: 'No native addon path provided' })
  process.exit(1)
}

interface NativeAddon {
  startCapture(
    options: {
      sampleRate: number
      tempFilePath?: string
      enableEchoCancellation?: boolean
      enableAGC?: boolean
      disableEchoCancellationOnHeadphones?: boolean
    },
    callback: (data: { source: string; buffer: Float32Array; timestamp: number }) => void
  ): void
  stopCapture(): void
  isCapturing(): boolean
  flushTempFile(): void
}

let native: NativeAddon
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  native = require(nativeAddonPath) as NativeAddon
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  process.parentPort.postMessage({ event: 'error', message: `Failed to load native addon: ${msg}` })
  process.exit(1)
}

let capturing = false

// Listen for control messages from the main process
process.parentPort.on('message', (msg) => {
  const data = msg.data

  if (data.event === 'start-capture') {
    try {
      native.startCapture(
        {
          sampleRate: data.options.sampleRate,
          tempFilePath: data.options.tempFilePath,
          enableEchoCancellation: data.options.enableEchoCancellation,
          enableAGC: data.options.enableAGC,
          disableEchoCancellationOnHeadphones: data.options.disableEchoCancellationOnHeadphones
        },
        (audioData) => {
          if (!capturing) return

          // Send audio data back through parentPort
          const buffer = audioData.buffer
          const arrayBuffer = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength
          )
          const transferred = new Float32Array(arrayBuffer)

          process.parentPort.postMessage(
            {
              event: 'audio-data',
              source: audioData.source,
              buffer: transferred,
              timestamp: audioData.timestamp
            }
          )
        }
      )

      capturing = true
      process.parentPort.postMessage({ event: 'started' })
    } catch (err) {
      process.parentPort.postMessage({
        event: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  } else if (data.event === 'stop-capture') {
    try {
      if (capturing) {
        native.stopCapture()
        capturing = false
      }
      process.parentPort.postMessage({ event: 'stopped' })
    } catch (err) {
      process.parentPort.postMessage({
        event: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  } else if (data.event === 'flush-temp-file') {
    if (capturing) {
      native.flushTempFile()
    }
  }
})

// Keep the process alive
const keepAlive = setInterval(() => {}, 60000)
keepAlive.ref()

// Clean up on disconnect
process.on('disconnect', () => {
  if (capturing) {
    native.stopCapture()
    capturing = false
  }
  clearInterval(keepAlive)
  process.exit(0)
})
