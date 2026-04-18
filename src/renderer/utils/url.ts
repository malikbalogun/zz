/**
 * Normalize a panel URL: strip trailing slashes, ensure it's a valid HTTP/HTTPS URL.
 */
export function normalizePanelUrl(url: string): string {
  if (!url) return url;
  let normalized = url.trim();
  // Ensure it starts with http:// or https:// (add https if missing)
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  // Remove trailing slash(es)
  normalized = normalized.replace(/\/+$/, '');
  return normalized;
}