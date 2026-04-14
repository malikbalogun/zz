import type { OutlookMessage } from './outlookService';
import { analyzeMessagesHeuristic, type HeuristicThreat } from './aiHeuristicScan';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function extractJsonFromContent(content: string): string {
  const t = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t);
  if (fence) return fence[1].trim();
  return t;
}

const LEVELS = new Set(['critical', 'high', 'medium', 'low', 'safe']);

function normalizeLevel(v: unknown): HeuristicThreat['threatLevel'] {
  const s = String(v || '').toLowerCase();
  return LEVELS.has(s) ? (s as HeuristicThreat['threatLevel']) : 'safe';
}

interface RawAssessment {
  id: string;
  threatLevel?: string;
  score?: number;
  threatType?: string;
  summary?: string;
  indicators?: string[];
  scamSusceptibilityRank?: number;
}

/**
 * Batch OpenAI analysis of inbox snippets (subject, from, body preview).
 * Proxied via main process `api:request` (no CORS). Falls back to heuristics on failure.
 */
function sortByScoreDesc(rows: HeuristicThreat[]): HeuristicThreat[] {
  return [...rows].sort((a, b) => b.score - a.score);
}

export async function analyzeMessagesOpenAI(
  messages: OutlookMessage[],
  accountEmail: string,
  apiKey: string,
  model: string
): Promise<HeuristicThreat[]> {
  const fallback = sortByScoreDesc(analyzeMessagesHeuristic(messages, accountEmail));
  if (!messages.length) return fallback;

  const lines = messages.map((m, i) => {
    const fromAddr = m.from?.emailAddress?.address || '';
    const subj = m.subject || '(No subject)';
    const prev = truncate(m.bodyPreview || '', 600);
    return `[${i + 1}] id=${m.id}\nfrom=${fromAddr}\nsubject=${subj}\npreview=${prev}`;
  });

  const system = `You are an email security analyst. You only see subject, sender address, and a short preview — not full MIME bodies.

Assess phishing, BEC/wire fraud, credential theft, advance-fee scams, and social-engineering manipulation. Score higher when the user would be more likely to fall for a scam (urgency, impersonation, fake invoices, payment redirects).

Return a single JSON object (no markdown) with this shape:
{"assessments":[{"id":"<exact id from input>","threatLevel":"critical"|"high"|"medium"|"low"|"safe","score":0-100,"threatType":"short label","summary":"1-3 sentences","indicators":["..."],"scamSusceptibilityRank":1}]}

Rules:
- Include every message id exactly once. ids must match the input verbatim.
- score: 0 = benign, 100 = very likely harmful or highly manipulative.
- scamSusceptibilityRank: integer 1..N where N is the number of messages; 1 = MOST susceptible to scams in this batch (most dangerous to trust), N = least susceptible. No duplicate ranks.`;

  const user = `Account owner mailbox: ${accountEmail}\n\nMessages:\n\n${lines.join('\n\n')}`;

  let data: any;
  try {
    const res = await window.electron.api.request({
      url: OPENAI_URL,
      method: 'POST',
      timeoutMs: 90000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model: model || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });
    if (!res.ok) {
      const err = res.data?.error?.message || res.data?.message || JSON.stringify(res.data);
      throw new Error(`OpenAI ${res.status}: ${err}`);
    }
    data = res.data;
  } catch (e: any) {
    console.warn('[aiOpenAiAnalysis] OpenAI request failed, using heuristics:', e?.message || e);
    return fallback;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return fallback;
  }

  let parsed: { assessments?: RawAssessment[] };
  try {
    parsed = JSON.parse(extractJsonFromContent(content));
  } catch {
    return fallback;
  }

  const assessments = parsed?.assessments;
  if (!Array.isArray(assessments)) {
    return fallback;
  }

  const byId = new Map<string, RawAssessment>();
  for (const a of assessments) {
    if (a && typeof a.id === 'string') byId.set(a.id, a);
  }

  const merged: HeuristicThreat[] = messages.map(msg => {
    const h = fallback.find(f => f.id === msg.id)!;
    const raw = byId.get(msg.id);
    if (!raw) {
      return h;
    }
    const score = Math.min(100, Math.max(0, Number(raw.score) || 0));
    return {
      ...h,
      threatLevel: normalizeLevel(raw.threatLevel),
      threatType: typeof raw.threatType === 'string' && raw.threatType.trim() ? raw.threatType.trim() : h.threatType,
      summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : h.summary,
      score,
      indicators: Array.isArray(raw.indicators) && raw.indicators.length
        ? raw.indicators.map(x => String(x)).filter(Boolean)
        : h.indicators,
      aiProvider: 'openai',
      analyzed: true,
      scamSusceptibilityRank:
        typeof raw.scamSusceptibilityRank === 'number' && Number.isFinite(raw.scamSusceptibilityRank)
          ? Math.round(raw.scamSusceptibilityRank)
          : undefined,
    };
  });

  merged.sort((a, b) => {
    const ra = a.scamSusceptibilityRank ?? 9999;
    const rb = b.scamSusceptibilityRank ?? 9999;
    if (ra !== rb) return ra - rb;
    return b.score - a.score;
  });

  return merged;
}
