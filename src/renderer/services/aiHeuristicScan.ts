import type { OutlookMessage } from './outlookService';

export type ThreatAnalysisProvider = 'heuristic' | 'openai' | 'anthropic';

export interface HeuristicThreat {
  id: string;
  email: string;
  account: string;
  subject: string;
  from: string;
  threatLevel: 'critical' | 'high' | 'medium' | 'low' | 'safe';
  threatType: string;
  summary: string;
  score: number;
  timestamp: string;
  indicators: string[];
  aiProvider: ThreatAnalysisProvider;
  analyzed: boolean;
  /** Lower = more scam-susceptible within the scanned batch (OpenAI ranking). */
  scamSusceptibilityRank?: number;
}

const URGENCY = /\b(urgent|immediately|wire transfer|verify (your )?account|act now|suspended|click (here|below)|within \d+ (hour|minute)|eod|asap|time-?sensitive)\b/i;
const BEC =
  /\b(wire|swift|invoice payment|new (bank|account) details|confidential|gift card|vendor payment|ceo|cfo|executive|kindly (send|confirm|process)|routing number|sort code|iban change|updated invoice|payment to this account)\b/i;
/** Lookalikes only — do NOT match legitimate "microsoft"/"outlook". */
const PHISH_DOMAIN = /(micr0soft|paypaI|arnazon|secure-login|verify-account|m1crosoft|rnicrosoft|out1ook|0utlook|g00gle|goog1e)[.-]/i;
const VERIFICATION_FLOW =
  /\b(verification code|verify code|one[- ]?time (pass(code|word)|code)|otp|auth(entication)? code|2fa|mfa|password reset code|security code)\b/i;
const EXPECTED_VERIFICATION_CONTEXT =
  /\b(if you (didn'?t|did not) request|no further action required|do not share|for your security|this code expires|sign[- ]?in attempt|account activity)\b/i;
const BRAND_IMPERSONATION =
  /\b(microsoft|onedrive|office ?365|google|gmail|apple|paypal|amazon|bank)\b/i;
const PAYMENT_TERMS =
  /\b(invoice|payment|remittance|beneficiary|bank transfer|wire transfer|swift|iban|routing number|account number|purchase order|po number|overdue|past due|settlement)\b/i;
const BANK_CHANGE_REQUEST =
  /\b(change|changed|update|updated|new)\s+(bank|banking|payment|beneficiary|account)\s+(details|information|instructions)\b/i;
const EXEC_FINANCE_ROLE =
  /\b(ceo|cfo|finance director|managing director|founder|accounts payable|payroll)\b/i;
const PAYMENT_ACTION =
  /\b(process|approve|release|send|transfer|pay|confirm|settle)\b/i;
const GIFT_CARD_FRAUD = /\b(gift card|itunes|apple card|steam card|amazon voucher)\b/i;

const TRUSTED_SENDER_DOMAIN_ALLOWLIST = [
  '.microsoft.com',
  '.microsoftonline.com',
  '.office.com',
  '.office365.com',
  '.outlook.com',
  '.onmicrosoft.com',
  '.google.com',
  '.googlemail.com',
  '.gmail.com',
];

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase().trim() : '';
}

function isTrustedBrandDomain(domain: string): boolean {
  if (!domain) return false;
  return TRUSTED_SENDER_DOMAIN_ALLOWLIST.some(suffix => domain === suffix.slice(1) || domain.endsWith(suffix));
}

function scoreMessage(msg: OutlookMessage, accountEmail: string): Omit<HeuristicThreat, 'id' | 'aiProvider' | 'analyzed'> {
  const fromAddr = msg.from?.emailAddress?.address || '';
  const fromDomain = domainOf(fromAddr);
  const subj = msg.subject || '';
  const prev = msg.bodyPreview || '';
  const blob = `${subj} ${prev} ${fromAddr}`;
  const indicators: string[] = [];
  let score = 10;
  const hasVerificationLanguage = VERIFICATION_FLOW.test(blob);
  const looksLikeBrandTheme = BRAND_IMPERSONATION.test(blob);
  const trustedBrandDomain = isTrustedBrandDomain(fromDomain);
  const hasUrgency = URGENCY.test(blob);
  const hasPaymentTerms = PAYMENT_TERMS.test(blob);
  const hasBankChange = BANK_CHANGE_REQUEST.test(blob);
  const hasExecFinance = EXEC_FINANCE_ROLE.test(blob);
  const hasPaymentAction = PAYMENT_ACTION.test(blob);
  const hasGenericBec = BEC.test(blob);
  const hasGiftCardFraud = GIFT_CARD_FRAUD.test(blob);

  if (PHISH_DOMAIN.test(fromAddr) || PHISH_DOMAIN.test(blob)) {
    indicators.push('Suspicious or lookalike domain');
    score += 45;
  }
  if (hasUrgency) {
    indicators.push('Urgency / pressure language');
    score += 20;
  }
  if (hasGenericBec) {
    indicators.push('Possible BEC / payment language');
    score += 25;
  }
  if (hasPaymentTerms) {
    indicators.push('Payment or invoice discussion');
    score += 18;
  }
  if (hasBankChange) {
    indicators.push('Bank/account change request');
    score += 28;
  }
  if (hasGiftCardFraud) {
    indicators.push('Gift-card payment request pattern');
    score += 35;
  }
  if (hasPaymentTerms && hasUrgency) {
    indicators.push('Urgent payment request combination');
    score += 12;
  }
  if (hasExecFinance && hasPaymentAction && (hasPaymentTerms || hasGenericBec)) {
    indicators.push('Executive/finance impersonation style request');
    score += 24;
  }
  if (hasVerificationLanguage) {
    indicators.push('Account verification / OTP flow language');
    score += 26;
    if (trustedBrandDomain) {
      indicators.push('Likely legitimate service domain (not lookalike) — still risky if unsolicited');
      score += 16;
    } else if (looksLikeBrandTheme) {
      indicators.push('Brand-themed verification request from untrusted sender domain');
      score += 24;
    }
  }
  if (/support@(microsoft|google)\./i.test(fromAddr) && !/\.(com|net)\.microsoft\.com/i.test(fromAddr)) {
    const dom = fromAddr.split('@')[1]?.toLowerCase() || '';
    if (dom && !['microsoft.com', 'google.com'].some(d => dom === d)) {
      indicators.push('Brand name in sender with mismatched domain');
      score += 30;
    }
  }
  if (
    hasVerificationLanguage &&
    trustedBrandDomain &&
    EXPECTED_VERIFICATION_CONTEXT.test(blob) &&
    !hasGenericBec &&
    !hasPaymentTerms &&
    !PHISH_DOMAIN.test(blob)
  ) {
    indicators.push('Transactional verification context detected (possible expected login flow)');
    score -= 10;
  }

  score = Math.min(100, Math.max(0, score));

  let threatLevel: HeuristicThreat['threatLevel'] = 'safe';
  if (score >= 80) threatLevel = 'critical';
  else if (score >= 60) threatLevel = 'high';
  else if (score >= 40) threatLevel = 'medium';
  else if (score >= 20) threatLevel = 'low';

  let threatType = 'Routine';
  if (score >= 60) threatType = 'Suspicious — review';
  if (hasPaymentTerms || hasGenericBec || hasBankChange || hasGiftCardFraud) threatType = 'BEC / payment risk';
  if (PHISH_DOMAIN.test(blob)) threatType = 'Possible phishing';
  if (hasVerificationLanguage && score >= 60) threatType = 'Account takeover / verification risk';

  const summary =
    score >= 40
      ? `Heuristic scan flagged this message based on sender, subject, and preview text. Score ${score}/100. This is a local rules-based check, not a cloud LLM.`
      : `Low priority. Heuristic scan found no strong indicators (score ${score}/100).`;

  return {
    email: msg.id,
    account: accountEmail,
    subject: subj || '(No subject)',
    from: fromAddr || '(unknown)',
    threatLevel,
    threatType,
    summary,
    score,
    timestamp: msg.receivedDateTime,
    indicators: indicators.length ? indicators : ['No strong indicators'],
  };
}

export function analyzeMessagesHeuristic(
  messages: OutlookMessage[],
  accountEmail: string
): HeuristicThreat[] {
  return messages.map(msg => ({
    id: msg.id,
    aiProvider: 'heuristic',
    analyzed: true,
    ...scoreMessage(msg, accountEmail),
  }));
}
