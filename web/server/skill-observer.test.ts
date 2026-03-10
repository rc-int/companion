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
  return { default: { Client: MockClient } }
})

// Mock settings manager
vi.mock('./settings-manager.js', () => ({
  getSettings: vi.fn(() => ({ anthropicApiKey: 'test-key' })),
  DEFAULT_ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
}))

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

  it('skips when no API key is configured', async () => {
    const { getSettings } = await import('./settings-manager.js')
    ;(getSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({ anthropicApiKey: '' })

    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session', baseMetrics)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('calls Haiku with correct prompt structure', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '[]' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session', baseMetrics)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const body = JSON.parse(opts!.body as string)
    expect(body.model).toBe('claude-haiku-4-5-20251001')
    expect(body.max_tokens).toBe(500)
    expect(body.temperature).toBe(0)
    expect(body.messages[0].content).toContain('Duration: 15 minutes')
    expect(body.messages[0].content).toContain('Prompts: 5')
    expect(body.messages[0].content).toContain('Bash: 2')
    expect(body.messages[0].content).toContain('Error: module not found')
  })

  it('writes gaps to database when Haiku returns them', async () => {
    const gaps = [{ domain: 'docker-compose', signal: 'repeated docker errors', severity: 'high' }]
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(gaps) }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session-abc', baseMetrics)

    expect(mockConnect).toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO skill_events'),
      expect.arrayContaining(['docker-compose'])
    )
    expect(mockEnd).toHaveBeenCalled()
  })

  it('does not write to DB when Haiku returns empty array', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '[]' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { onSessionExit } = await import('./skill-observer.js')
    await onSessionExit('test-session', baseMetrics)

    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('handles Haiku API failure gracefully', async () => {
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

  it('handles malformed Haiku response gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'not valid json' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { onSessionExit } = await import('./skill-observer.js')
    // Should not throw
    await onSessionExit('test-session', baseMetrics)
  })
})
