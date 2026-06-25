import WebSocket from 'ws'
import { DEFAULT_WS_BASE } from './constants'

// The bidirectional frame protocol spoken over the run WebSocket.
// Down: stdout/stderr/status/done/error. Up (future): stop/input.
export interface StreamFrame {
  type: 'stdout' | 'stderr' | 'status' | 'done' | 'error'
  data?: string
  status?: string
}

export interface StreamOptions {
  token: string
  runId: string
  onFrame: (frame: StreamFrame) => void
  wsBase?: string
}

// Subscribes to an agent run's live output over WebSocket.
// TODO: reconnect with backoff + resume cursor, and ping/pong heartbeat to
// detect dead sockets. Stubbed until the server-side frame protocol lands.
export function streamRun({
  token,
  runId,
  onFrame,
  wsBase = DEFAULT_WS_BASE,
}: StreamOptions): () => void {
  const ws = new WebSocket(`${wsBase}/v1/runs/${runId}/stream`, {
    headers: { authorization: `Bearer ${token}` },
  })

  ws.on('message', (raw) => {
    onFrame(JSON.parse(raw.toString()) as StreamFrame)
  })
  ws.on('error', (err) => onFrame({ type: 'error', data: String(err) }))
  ws.on('close', () => onFrame({ type: 'done' }))

  return () => ws.close()
}
