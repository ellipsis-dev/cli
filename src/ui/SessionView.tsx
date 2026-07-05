import React, { useEffect, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import Spinner from 'ink-spinner'
import { streamSession, type StreamFrame } from '../lib/ws'

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
        case 'stdout':
        case 'stderr':
          setLines((prev) => [...prev, frame.data ?? ''])
          break
        case 'status':
          setStatus(frame.status ?? 'running')
          break
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
