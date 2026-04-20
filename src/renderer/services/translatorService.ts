import { getSettings } from './settingsService';

export interface TranslationResult {
  translated: string;
  /** ISO 639-1 source language reported by the API, e.g. "es", "fr". */
  sourceLang?: string;
  /** Endpoint we actually hit, for debug/logs. */
  endpoint: string;
}

/** Default to the public Argos community instance. Plain HTTPS, no API key. */
export const DEFAULT_TRANSLATOR_ENDPOINT = 'https://translate.argosopentech.com/translate';

const TRANSLATE_TIMEOUT_MS = 20000;

/**
 * POST one block of text to a LibreTranslate-compatible endpoint
 * (https://github.com/LibreTranslate/LibreTranslate). Argos is the default;
 * users can override the URL in Settings → Translation.
 *
 * We deliberately use the main-process api.request proxy so we don't have to
 * deal with CORS, fetch timeouts, or rendering-thread blocking.
 */
export async function translateText(text: string): Promise<TranslationResult> {
  const trimmed = (text || '').trim();
  if (!trimmed) return { translated: '', endpoint: '(no input)' };

  const settings = await getSettings();
  const cfg = settings.translation || {};
  if (cfg.enabled === false) {
    throw new Error('Translation is disabled in Settings.');
  }
  const endpoint = (cfg.endpoint && cfg.endpoint.trim()) || DEFAULT_TRANSLATOR_ENDPOINT;
  const target = (cfg.targetLang && cfg.targetLang.trim()) || 'en';
  const apiKey = (cfg.apiKey && cfg.apiKey.trim()) || undefined;

  const body: Record<string, unknown> = {
    q: trimmed,
    source: 'auto',
    target,
    format: 'text',
  };
  if (apiKey) body.api_key = apiKey;

  const response = await window.electron.api.request({
    url: endpoint,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: TRANSLATE_TIMEOUT_MS,
  });
  if (!response.ok) {
    const errMsg =
      (response.data && (response.data.error || response.data.message)) ||
      `HTTP ${response.status}`;
    throw new Error(`Translation failed: ${errMsg}`);
  }
  const data = response.data || {};
  const translated =
    typeof data.translatedText === 'string'
      ? data.translatedText
      : typeof data.translation === 'string'
        ? data.translation
        : '';
  if (!translated) {
    throw new Error('Translation endpoint returned an empty result.');
  }
  const sourceLang =
    (data.detectedLanguage &&
      typeof data.detectedLanguage === 'object' &&
      typeof data.detectedLanguage.language === 'string'
      ? data.detectedLanguage.language
      : typeof data.detectedLanguage === 'string'
        ? data.detectedLanguage
        : undefined) as string | undefined;
  return { translated, sourceLang, endpoint };
}

/**
 * Translate a chunk that may be HTML by stripping tags first. Returns the
 * translated plain text wrapped in a single <pre> block so the renderer's
 * dangerouslySetInnerHTML still works without losing whitespace.
 */
export async function translateHtmlBody(html: string): Promise<TranslationResult> {
  const stripped = stripHtmlPreserveBreaks(html);
  const result = await translateText(stripped);
  return result;
}

/** Naïve HTML→text: replace <br>/<p>/<div> closes with newlines, drop other tags. */
function stripHtmlPreserveBreaks(html: string): string {
  return html
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
