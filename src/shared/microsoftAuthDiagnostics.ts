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
    suggestions: [
      'The password is wrong (or the account uses passkey / SSO and has no password).',
      'Update the saved credentials, or use Device Code instead.',
    ],
  },
  AADSTS50034: {
    title: 'Account does not exist in tenant',
    suggestions: [
      'Double-check the email address.',
      'For multi-tenant flows, set tenant = `common` in Settings → Microsoft OAuth.',
    ],
  },
  AADSTS50053: {
    title: 'Account is locked',
    suggestions: [
      'Microsoft has locked the account due to too many failed sign-in attempts (smart lockout).',
      'Wait ~15 minutes, or have the admin unlock it in Entra ID.',
    ],
  },
  AADSTS50055: {
    title: 'Password expired',
    suggestions: [
      'Sign in interactively in a browser and set a new password.',
      'Saved-credential autofill cannot recover from this — Microsoft will force a password reset.',
    ],
  },
  AADSTS50056: {
    title: 'Password is missing or invalid for this account',
    suggestions: [
      'The account exists but has no password set in Microsoft (passkey / SSO / federated only).',
      'Use Device Code or interactive sign-in instead.',
    ],
  },
  AADSTS50057: {
    title: 'User account is disabled',
    suggestions: [
      'The admin disabled this account in Entra ID. It must be re-enabled before sign-in.',
    ],
  },
  AADSTS50058: {
    title: 'Sign-in session not found',
    suggestions: [
      'AAD does not see an active session — usually means cookies were cleared.',
      'Run an interactive sign-in (Capture browser cookies) to re-establish the session.',
    ],
  },
  AADSTS50059: {
    title: 'Tenant identifier missing',
    suggestions: [
      'Add the email or tenant GUID to the request — set Tenant in Settings → Microsoft OAuth.',
    ],
  },
  AADSTS50128: {
    title: 'Invalid domain',
    suggestions: [
      'The email\u2019s domain is not registered in any AAD tenant.',
      'Confirm the email is a real Microsoft 365 / Entra ID account.',
    ],
  },
  AADSTS50173: {
    title: 'Stale credentials — fresh sign-in required',
    suggestions: [
      'Microsoft revoked the session because the password / MFA / device state changed.',
      'Run an interactive sign-in to refresh the session.',
    ],
  },
  AADSTS65004: {
    title: 'User declined consent',
    suggestions: [
      'On the AAD consent screen the user clicked "No" / "Cancel".',
      'Run the flow again and approve the requested permissions.',
    ],
  },
  AADSTS70008: {
    title: 'Refresh token expired or revoked',
    suggestions: [
      'Re-authenticate via Device Code or Cookie → Token.',
      'This is normal after ~90 days of inactivity, password reset, or admin "sign out everywhere".',
    ],
  },
  AADSTS70016: {
    title: 'Authorization pending — user has not finished sign-in',
    suggestions: [
      'Open the verification URL in a browser and enter the device code shown on the Add Account screen.',
      'Polling will keep retrying for ~15 minutes; complete the sign-in before then.',
    ],
  },
  AADSTS70019: {
    title: 'Device code expired',
    suggestions: [
      'The verification code only lives for ~15 minutes from when it was issued.',
      'Click "Start Over" to generate a fresh code, then complete the AAD sign-in faster.',
    ],
  },
  AADSTS70020: {
    title: 'Device code already redeemed',
    suggestions: [
      'A previous poll already used this code. Click "Start Over" for a new one.',
    ],
  },
  AADSTS70043: {
    title: 'Refresh token has reached its maximum lifetime',
    suggestions: [
      'Refresh tokens have a hard ~90-day cap. Re-authenticate via Device Code.',
    ],
  },
  AADSTS900023: {
    title: 'Invalid grant type',
    suggestions: [
      'The token endpoint rejected the grant — usually means the request body is malformed.',
      'Update the app to the latest version and try again.',
    ],
  },
  AADSTS9002313: {
    title: 'Invalid client request',
    suggestions: [
      'The request was malformed (often happens when tenant is set wrong for this client).',
      'Try Tenant = `common` in Settings → Microsoft OAuth.',
    ],
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

  if (
    lower.includes('verification code expired') ||
    lower.includes('expired_token') ||
    code === 'AADSTS70019' ||
    code === 'AADSTS70020'
  ) {
    return {
      category: 'invalid_grant',
      title: hint?.title || 'Device code expired',
      detail: text,
      aadstsCode: code,
      suggestions: hint?.suggestions || [
        'Verification codes expire ~15 minutes after they are issued.',
        'Click "Start Over" to generate a fresh code, then sign in faster.',
      ],
    };
  }

  if (lower.includes('invalid_grant') || lower.includes('refresh_token_expired') || code === 'AADSTS70008' || code === 'AADSTS70043') {
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
