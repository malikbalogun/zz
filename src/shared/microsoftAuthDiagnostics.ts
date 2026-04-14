/**
 * Human-readable classification for Microsoft OAuth / Entra errors (renderer + main can import).
 */

export type MicrosoftAuthDiagnostic = {
  category:
    | 'invalid_grant'
    | 'mfa_required'
    | 'conditional_access'
    | 'consent_required'
    | 'wrong_client_or_resource'
    | 'network'
    | 'unknown';
  title: string;
  detail: string;
  aadstsCode?: string;
  suggestions: string[];
};

function extractAadstsCode(text: string): string | undefined {
  const m = text.match(/AADSTS\d+/i);
  return m ? m[0].toUpperCase() : undefined;
}

/** Map common AADSTS codes to guidance (non-exhaustive). */
const AADSTS_HINTS: Record<string, { title: string; suggestions: string[] }> = {
  AADSTS50076: {
    title: 'Multi-factor authentication required',
    suggestions: [
      'Complete MFA in the browser when prompted.',
      'If using device code or headless flows, switch to interactive sign-in.',
    ],
  },
  AADSTS50079: {
    title: 'MFA registration required',
    suggestions: ['Sign in once in a browser and complete security defaults / MFA enrollment.'],
  },
  AADSTS50158: {
    title: 'Conditional Access blocked the request',
    suggestions: [
      'Use a compliant device / approved app as required by your tenant policy.',
      'Ask your admin to review CA policies for this client and redirect URI.',
    ],
  },
  AADSTS65001: {
    title: 'Admin consent or user consent required',
    suggestions: ['Grant consent for the app in Entra ID, or use an admin-approved enterprise app registration.'],
  },
  AADSTS700016: {
    title: 'Wrong resource / application not found in directory',
    suggestions: [
      'Verify client ID and tenant in Settings → Microsoft OAuth.',
      'Ensure the app registration exists in that tenant.',
    ],
  },
  AADSTS7000218: {
    title: 'Request body must contain client_assertion or client_secret',
    suggestions: ['Public client flows must use PKCE (already used by this app for cookie→token).'],
  },
  AADSTS50126: {
    title: 'Invalid username or password',
    suggestions: ['Check credentials; password-based flows are not used by this bridge.'],
  },
};

export function diagnoseMicrosoftAuthError(raw: string): MicrosoftAuthDiagnostic {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  const code = extractAadstsCode(text);
  const hint = code ? AADSTS_HINTS[code] : undefined;

  if (lower.includes('network_error') || lower.includes('fetch failed') || lower.includes('etimedout')) {
    return {
      category: 'network',
      title: 'Network error',
      detail: text,
      suggestions: ['Check internet connectivity and try again.', 'Corporate proxies may block token endpoints.'],
    };
  }

  if (lower.includes('invalid_grant') || lower.includes('refresh_token_expired') || code === 'AADSTS70008') {
    return {
      category: 'invalid_grant',
      title: 'Token expired or revoked',
      detail: text,
      aadstsCode: code,
      suggestions: [
        'Re-authenticate the account (Device Code or Cookie → Token).',
        'Ensure the refresh token was issued for delegated Outlook (EWS) scope if you need OWA in-app.',
        ...(hint?.suggestions || []),
      ],
    };
  }

  if (
    code === 'AADSTS50076' ||
    code === 'AADSTS50079' ||
    lower.includes('multi-factor authentication') ||
    (lower.includes('mfa') && lower.includes('required'))
  ) {
    return {
      category: 'mfa_required',
      title: hint?.title || 'Additional authentication required',
      detail: text,
      aadstsCode: code,
      suggestions: hint?.suggestions || ['Complete MFA in the browser.'],
    };
  }

  if (code === 'AADSTS50158' || lower.includes('conditional access')) {
    return {
      category: 'conditional_access',
      title: hint?.title || 'Conditional Access policy blocked sign-in',
      detail: text,
      aadstsCode: code,
      suggestions: hint?.suggestions || ['Use a compliant device or approved client per tenant policy.'],
    };
  }

  if (code === 'AADSTS65001' || lower.includes('consent')) {
    return {
      category: 'consent_required',
      title: hint?.title || 'Consent required',
      detail: text,
      aadstsCode: code,
      suggestions: hint?.suggestions || ['Grant permissions for the application in Entra ID.'],
    };
  }

  if (
    code === 'AADSTS700016' ||
    lower.includes('invalid_client') ||
    lower.includes('invalid resource')
  ) {
    return {
      category: 'wrong_client_or_resource',
      title: hint?.title || 'Client or resource mismatch',
      detail: text,
      aadstsCode: code,
      suggestions: hint?.suggestions || ['Verify Microsoft OAuth client ID, tenant, and redirect URI in Settings.'],
    };
  }

  if (code && hint) {
    return {
      category: 'unknown',
      title: hint.title,
      detail: text,
      aadstsCode: code,
      suggestions: hint.suggestions,
    };
  }

  return {
    category: 'unknown',
    title: 'Authentication error',
    detail: text || 'No details provided.',
    aadstsCode: code,
    suggestions: [
      'Copy the full error from the browser or debug bundle and search for the AADSTS code in Microsoft documentation.',
    ],
  };
}
