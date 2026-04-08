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
  console.error('[AudioProcess] No native addon path provided')
  process.exit(1)
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require(nativeAddonPath) as {
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

let audioPort: MessagePort | null = null
let capturing = false

// Listen for control messages from the main process
process.parentPort.on('message', (msg) => {
  const data = msg.data

  if (data.event === 'start-capture') {
    // The MessagePort is transferred alongside the message
    if (msg.ports?.[0]) {
      audioPort = msg.ports[0]
    }

    if (!audioPort) {
      process.parentPort.postMessage({ event: 'error', message: 'No audio port provided' })
      return
    }

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
          if (!audioPort || !capturing) return

          // Transfer the Float32Array's underlying ArrayBuffer for zero-copy
          const buffer = audioData.buffer
          const arrayBuffer = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength
          )
          const transferred = new Float32Array(arrayBuffer)

          audioPort.postMessage(
            {
              source: audioData.source,
              buffer: transferred,
              timestamp: audioData.timestamp
            },
            [transferred.buffer]
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
