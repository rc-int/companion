/**
 * Skill Observer — client-agnostic gap detection for the skill lifecycle engine.
 *
 * Embedded in companion, runs on every CLI session exit. Analyzes session
 * friction (errors, tool patterns, duration) via a single Haiku call and
 * writes identified skill gaps to skill_events in PostgreSQL.
 *
 * Pure infrastructure: no delivery coupling (Discord/Telegram/etc).
 * Each companion instance becomes a gap-detection node feeding the central
 * PostgreSQL, enabling multi-user promotion in the arbiter.
 */

import { userInfo } from 'node:os'
import pg from 'pg'
import { getSettings } from './settings-manager.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const MIN_DURATION_MINUTES = 5
const MIN_PROMPT_COUNT = 3

/** Metrics collected from ws-bridge session state at CLI disconnect */
export interface SessionMetrics {
  durationMinutes: number
  promptCount: number
  errorStrings: string[]
  toolNames: string[]
}

/** A skill gap identified during post-session reflection */
interface ReflectionGap {
  domain: string
  signal: string
  severity: 'low' | 'medium' | 'high'
}

/**
 * Fire-and-forget session exit handler. Never throws.
 * Calls Haiku to analyze session friction, writes gaps to skill_events.
 */
export async function onSessionExit(sessionId: string, metrics: SessionMetrics): Promise<void> {
  try {
    // Skip trivial sessions
    if (metrics.durationMinutes < MIN_DURATION_MINUTES || metrics.promptCount < MIN_PROMPT_COUNT) {
      return
    }

    const apiKey = getSettings().anthropicApiKey.trim()
    if (!apiKey) {
      return
    }

    const gaps = await analyzeSession(apiKey, sessionId, metrics)
    if (gaps.length === 0) return

    await writeGapsToDb(sessionId, gaps)
  } catch (err) {
    console.warn(
      `[skill-observer] Error for session ${sessionId.slice(-8)}:`,
      (err as Error).message
    )
  }
}

async function analyzeSession(
  apiKey: string,
  sessionId: string,
  metrics: SessionMetrics
): Promise<ReflectionGap[]> {
  const { durationMinutes, promptCount, errorStrings, toolNames } = metrics
  const sid = sessionId.slice(-8)

  // Build tool frequency summary
  const toolCounts: Record<string, number> = {}
  for (const tool of toolNames) {
    toolCounts[tool] = (toolCounts[tool] || 0) + 1
  }
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, count]) => `${tool}: ${count}`)
    .join(', ')

  const errorSummary =
    errorStrings.length > 0
      ? `Errors encountered (${errorStrings.length}):\n${errorStrings.slice(0, 10).join('\n')}`
      : 'No errors encountered.'

  const prompt = `You are analyzing a completed coding session to identify skill gaps — areas where the developer's Claude assistant lacked knowledge that would have prevented friction.

Session stats:
- Duration: ${durationMinutes} minutes
- Prompts: ${promptCount}
- Tool calls: ${topTools || 'none tracked'}

${errorSummary}

Identify 0-3 skill gaps where a reusable skill/guide would have helped. Only flag clear, actionable gaps — not vague suggestions.

Respond with ONLY a JSON array (no markdown fencing):
[{"domain": "kebab-case-domain", "signal": "what indicated the gap", "severity": "low|medium|high"}]

If no clear gaps exist, respond with: []`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 500,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      console.warn(`[skill-observer] Haiku request failed: ${res.status} ${res.statusText}`)
      return []
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
    }

    const text = data.content?.[0]?.type === 'text' ? (data.content[0].text ?? '') : ''

    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const gaps = JSON.parse(jsonMatch[0]) as ReflectionGap[]
    if (!Array.isArray(gaps) || gaps.length === 0) return []

    console.log(
      `[skill-observer] Session ${sid}: ${gaps.length} gap(s) detected — ${gaps.map((g) => g.domain).join(', ')}`
    )
    return gaps
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn(`[skill-observer] Haiku call timed out for session ${sid}`)
    } else {
      console.warn(`[skill-observer] Haiku call failed for session ${sid}:`, (err as Error).message)
    }
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function writeGapsToDb(sessionId: string, gaps: ReflectionGap[]): Promise<void> {
  const databaseUrl =
    process.env.WILCO_DATABASE_URL ||
    process.env.OPC_POSTGRES_URL ||
    'postgresql://claude:claude_dev@localhost:5432/continuous_claude'

  const client = new pg.Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    const userId = userInfo().username

    for (const gap of gaps) {
      await client.query(
        `INSERT INTO skill_events (skill_slug, user_id, session_id, event_type, phase, metadata)
         VALUES ($1, $2, $3, 'gap_detected', 'reflection', $4)`,
        [
          gap.domain,
          userId,
          sessionId,
          JSON.stringify({ signal: gap.signal, severity: gap.severity }),
        ]
      )
    }

    console.log(
      `[skill-observer] ${gaps.length} gap(s) written to skill_events for session ${sessionId.slice(-8)}`
    )
  } catch (err) {
    console.warn(`[skill-observer] DB write failed:`, (err as Error).message)
  } finally {
    await client.end().catch(() => {})
  }
}
