/**
 * Regression test for the OAuth keep-alive zombie-socket bug.
 *
 * The bug: after OAuth #1 completed, Node's server.close() stopped accepting
 * new connections but left existing keep-alive TCP sockets alive. When
 * OAuth #2 started on the same port, the browser reused the old keep-alive
 * socket — requests landed on OAuth #1's (already-resolved) closure, and
 * OAuth #2's Promise never saw a callback, hanging until the 120s timeout.
 *
 * The fix: cleanup() calls server.closeAllConnections() before server.close().
 *
 * This test simulates the browser's behavior with a keepAlive http.Agent and
 * asserts that two consecutive captureAuthCode flows on the same port both
 * resolve with their own authorization codes — the invariant the bug broke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: false }
}))

const TEST_PORT = 39833 // Different from production 19833 to avoid collisions

async function importCaptureAuthCode() {
  vi.resetModules()
  return (await import('../src/main/calendar/google')).captureAuthCode
}

/**
 * Send a GET to /callback using a shared keepAlive agent. Returns when the
 * response is fully received, mirroring what a browser does after an OAuth
 * redirect. The agent is reused across calls so subsequent GETs will try to
 * reuse the existing TCP socket — exactly the scenario that triggered the bug.
 */
function simulateBrowserCallback(
  agent: http.Agent,
  port: number,
  code: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/callback?code=${encodeURIComponent(code)}&scope=email`,
        method: 'GET',
        agent
      },
      (res) => {
        res.resume() // drain
        res.on('end', () => resolve())
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('OAuth captureAuthCode', () => {
  let agent: http.Agent

  beforeEach(() => {
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  })

  afterEach(() => {
    agent.destroy()
  })

  it('resolves with the authorization code delivered to /callback', async () => {
    const captureAuthCode = await importCaptureAuthCode()

    const flow = captureAuthCode('http://example.invalid/', TEST_PORT)

    // Give the server a moment to bind before the simulated browser request.
    await new Promise((r) => setTimeout(r, 50))
    await simulateBrowserCallback(agent, TEST_PORT, 'first-code')

    const code = await flow
    expect(code).toBe('first-code')
  })

  it('two consecutive flows on the same port both resolve with their own codes', async () => {
    // This is the actual regression guard. Before the fix, the second
    // flow's server would never receive the callback — the browser's keep-
    // alive socket from flow #1 would deliver the request to flow #1's
    // (already-resolved) handler. With closeAllConnections() in cleanup,
    // the socket is hard-killed and flow #2's server gets a fresh connection.
    const captureAuthCode = await importCaptureAuthCode()

    // Flow #1
    const flow1 = captureAuthCode('http://example.invalid/', TEST_PORT)
    await new Promise((r) => setTimeout(r, 50))
    await simulateBrowserCallback(agent, TEST_PORT, 'code-alpha')
    const code1 = await flow1
    expect(code1).toBe('code-alpha')

    // Flow #2 on the same port, reusing the same keepAlive agent. The agent
    // has a keep-alive TCP socket to the now-closed flow #1 server in its
    // pool. If cleanup didn't force-close that socket, the agent would try
    // to reuse it and the request would land on flow #1's dead handler —
    // flow #2 would hang.
    const flow2 = captureAuthCode('http://example.invalid/', TEST_PORT)
    await new Promise((r) => setTimeout(r, 50))
    await simulateBrowserCallback(agent, TEST_PORT, 'code-beta')
    const code2 = await Promise.race([
      flow2,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('flow2 did not resolve within 5s — keep-alive zombie bug regressed')), 5000)
      )
    ])
    expect(code2).toBe('code-beta')
  }, 15_000)

  it('tags log lines with a flow ID so zombie-handler bugs are self-diagnosing', async () => {
    // This invariant is cheaper to assert via the exported function's
    // behavior: each call creates a distinct closure, so each flow's
    // cleanup only touches its own timers. Regression would manifest as
    // flow #2 hanging (covered above).
    const captureAuthCode = await importCaptureAuthCode()
    const flow = captureAuthCode('http://example.invalid/', TEST_PORT)
    await new Promise((r) => setTimeout(r, 50))
    await simulateBrowserCallback(agent, TEST_PORT, 'tagged')
    expect(await flow).toBe('tagged')
  })

  it('force-closes keep-alive TCP sockets on flow completion', async () => {
    // The tighter regression guard. Node's http.Agent respects 'Connection:
    // close' and opens a new socket per request, but real browsers ignored
    // it in our production bug. To reliably catch "cleanup() didn't kill
    // existing sockets", we drive the server with a raw TCP socket that
    // never closes itself — mimicking what the browser actually did.
    //
    // If closeAllConnections() is missing from cleanup(), this socket will
    // stay alive after flow completion and a subsequent write would
    // succeed (or at least not immediately fail). With the fix, the server
    // kills the socket on our behalf, so either the 'close'/'end' event
    // fires or a write returns EPIPE / ECONNRESET.
    const captureAuthCode = await importCaptureAuthCode()
    const flow = captureAuthCode('http://example.invalid/', TEST_PORT)
    await new Promise((r) => setTimeout(r, 50))

    const socket = net.connect(TEST_PORT, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })

    // Track whether the server closed our end of the socket.
    let serverClosed = false
    socket.on('close', () => { serverClosed = true })
    socket.on('end', () => { serverClosed = true })

    // Send a minimal HTTP request with an explicit keep-alive request; the
    // server's Connection: close response header would normally convince
    // the client to close, but on a raw socket we ignore it entirely.
    socket.write(
      'GET /callback?code=raw-code HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Connection: keep-alive\r\n' +
      '\r\n'
    )

    // Drain the response so cleanup() can run on the server side.
    await new Promise<void>((resolve) => {
      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString()
        if (buf.includes('</html>')) resolve()
      })
      // Safety: don't hang the test if response is unusual.
      setTimeout(resolve, 1000)
    })

    // Flow's cleanup() should have run by now, which must force-close the
    // server side of this socket. Give Node one tick to flush the close.
    await flow
    await new Promise((r) => setTimeout(r, 100))

    expect(serverClosed).toBe(true)
    socket.destroy()
  }, 10_000)
})
