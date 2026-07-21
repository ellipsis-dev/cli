import React, { useEffect, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import Spinner from 'ink-spinner'
import { sessionStatusWord, streamSession, type StreamFrame } from '../lib/ws'
import { isConnectVisibleRecord, recordToItems } from '../lib/events'
import type { AgentSession, SessionRecord } from '../lib/types'

interface Props {
  sessionId: string
  token: string
}

export function SessionView({ sessionId, token }: Props): React.ReactElement {
  const { exit } = useApp()
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState<string>('connecting')

  useEffect(() => {
    const controller = new AbortController()
    const onFrame = (frame: StreamFrame) => {
      switch (frame.type) {
        case 'records_append': {
          const records = (frame as { records: SessionRecord[] }).records
          const rendered = records
            .filter(isConnectVisibleRecord)
            .flatMap((record) => recordToItems(record, `v${record.feed_seq}`))
            .map((item) => (item.detail ? `${item.text}  ${item.detail}` : item.text))
            .filter((line) => line.trim().length > 0)
          if (rendered.length) setLines((prev) => [...prev, ...rendered])
          break
        }
        case 'snapshot':
        case 'session':
          setStatus(sessionStatusWord((frame as { session: AgentSession }).session))
          break
        default:
          break // heartbeat/messages/delta/unknown: nothing to draw here
      }
    }
    streamSession({ token, sessionId, onFrame, signal: controller.signal })
      .then((outcome) => {
        if (outcome.type === 'error') setStatus(`error: ${outcome.message}`)
        else if (outcome.type === 'done') setStatus('done')
        exit()
      })
      .catch((err: Error) => {
        setStatus(`error: ${err.message}`)
        exit()
      })
    return () => controller.abort()
  }, [sessionId, token, exit])

  const done = status === 'done'

  return (
    <Box flexDirection="column">
      <Box>
        {done ? <Text color="green">✓ </Text> : <Spinner type="dots" />}
        <Text color="cyan">
          {' '}
          session {sessionId}: {status}
        </Text>
      </Box>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  )
}
