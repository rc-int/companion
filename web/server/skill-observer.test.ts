import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMetrics } from './skill-observer.js'

// Track mock client calls
const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockEnd = vi.fn().mockResolvedValue(undefined)

// Mock pg module — Client must be a real class for `new` to work
vi.mock('pg', () => {
  class MockClient {
    connect = mockConnect
    query = mockQuery
    end = mockEnd
  }
  return { Client: MockClient }
})

describe('skill-observer', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.clearAllMocks()
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  const baseMetrics: SessionMetrics = {
    durationMinutes: 15,
    promptCount: 5,
    errorStrings: ['Error: module not found'],
    toolNames: ['Bash', 'Read', 'Bash', 'Edit'],
  }

  /** Helper: build an OpenAI-format proxy response */
  function proxyResponse(content: string) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  it('skips sessions shorter than 5 minutes', async () => {
    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session', { ...baseMetrics, durationMinutes: 3 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('skips sessions with fewer than 3 prompts', async () => {
    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session', { ...baseMetrics, promptCount: 2 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('calls CLI proxy with correct prompt structure', async () => {
    fetchSpy.mockResolvedValueOnce(proxyResponse('[]'))

    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session', baseMetrics)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchSpy.mock.calls[0]
    // Should call CLI proxy, not Anthropic directly
    expect(url).toBe('http://localhost:8318/v1/chat/completions')
    const body = JSON.parse(opts!.body as string)
    expect(body.model).toBe('claude-haiku-4-5-20251001')
    expect(body.max_tokens).toBe(500)
    expect(body.temperature).toBe(0)
    expect(body.messages[0].content).toContain('Duration: 15 minutes')
    expect(body.messages[0].content).toContain('Prompts: 5')
    expect(body.messages[0].content).toContain('Bash: 2')
    expect(body.messages[0].content).toContain('Error: module not found')
    // Should NOT have Anthropic-specific headers
    expect(opts!.headers).not.toHaveProperty('x-api-key')
    expect(opts!.headers).not.toHaveProperty('anthropic-version')
  })

  it('writes gaps to database when proxy returns them', async () => {
    const gaps = [{ domain: 'docker-compose', signal: 'repeated docker errors', severity: 'high' }]
    fetchSpy.mockResolvedValueOnce(proxyResponse(JSON.stringify(gaps)))

    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session-abc', baseMetrics)

    expect(mockConnect).toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO skill_events'),
      expect.arrayContaining(['docker-compose'])
    )
    expect(mockEnd).toHaveBeenCalled()
  })

  it('does not write to DB when proxy returns empty array', async () => {
    fetchSpy.mockResolvedValueOnce(proxyResponse('[]'))

    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session', baseMetrics)

    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('handles proxy API failure gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))

    const { onSessionExit } = await import('./skill-observer.js')
    // Should not throw
    await onSessionExit('test-session', baseMetrics)
  })

  it('handles fetch timeout gracefully', async () => {
    fetchSpy.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))

    const { onSessionExit } = await import('./skill-observer.js')
    // Should not throw
    await onSessionExit('test-session', baseMetrics)
  })

  it('handles malformed proxy response gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(proxyResponse('not valid json'))

    const { onSessionExit } = await import('./skill-observer.js')
    // Should not throw
    await onSessionExit('test-session', baseMetrics)
  })
})
