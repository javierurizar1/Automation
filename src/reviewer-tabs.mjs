function chatUrlKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return null;
  }
}

const GENERATION_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop generating"]',
  'button[aria-label="Stop"]',
];
const DEFAULT_REVIEWER_PROBE_TIMEOUT_MS = 2500;

function reviewerPages(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`);
        error.code = 'REVIEWER_PROBE_TIMEOUT';
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function healthResult(state, actualGeneration, reason, evidence = null) {
  return { state, actualGeneration, checkedAt: new Date().toISOString(), reason, evidence };
}

/**
 * Classify a reviewer using live browser evidence. A stored reservation or chat
 * URL is deliberately not accepted as proof that a generation is active.
 */
export async function classifyReviewerHealth(page, { timeoutMs = DEFAULT_REVIEWER_PROBE_TIMEOUT_MS } = {}) {
  const boundedTimeoutMs = Math.max(100, Math.min(15000, Number(timeoutMs) || DEFAULT_REVIEWER_PROBE_TIMEOUT_MS));
  if (!page || typeof page.isClosed !== 'function') {
    return healthResult('UNREACHABLE', false, 'reviewer page is unavailable');
  }

  try {
    if (page.isClosed()) return healthResult('DISCONNECTED', false, 'reviewer page is closed');
    const browser = page.context?.()?.browser?.();
    if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) {
      return healthResult('DISCONNECTED', false, 'browser connection is closed');
    }
  } catch (error) {
    return healthResult('DISCONNECTED', false, `reviewer page is disconnected: ${error.message || error}`);
  }

  let url = '';
  try {
    url = String(page.url?.() || '');
  } catch {
    return healthResult('DISCONNECTED', false, 'reviewer page URL is unavailable');
  }
  if (/accounts\.google\.com|auth\.openai\.com|chatgpt\.com\/auth\/login/i.test(url)) {
    return healthResult('AUTH_REQUIRED', false, 'reviewer is on an authentication page', { url });
  }

  try {
    const inspectGeneration = /\/c\/[^/]+/i.test(url);
    const dom = await withTimeout(page.evaluate(({ selectors, inspectGeneration: checkGeneration }) => {
      const visible = (element) => {
        if (!element || !element.getClientRects().length) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      let stop = null;
      if (checkGeneration) {
        for (const selector of selectors) {
          if (visible(document.querySelector(selector))) {
            stop = selector;
            break;
          }
        }
      }
      const composerElement = document.querySelector('#prompt-textarea')
        || document.querySelector('[role="textbox"][contenteditable="true"]');
      const composer = visible(composerElement);
      // A visible composer is enough to establish that the conversation UI is
      // ready. If it is absent, inspect text without reading innerText, which
      // forces a full-page layout and can stall Firefox on long conversations
      // or partially loaded pages before the bounded health probe can finish.
      const bodyText = composer ? '' : String(document.body?.textContent || '').slice(0, 12000);
      return {
        stopSelector: stop,
        bodyText,
        composer,
        title: String(document.title || ''),
        readyState: document.readyState,
        online: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
      };
    }, { selectors: GENERATION_SELECTORS, inspectGeneration }), boundedTimeoutMs, 'reviewer health probe');
    const bodyText = String(dom.bodyText || '');
    const compactText = bodyText.toLowerCase().replace(/\s+/g, ' ');
    const title = String(dom.title || '');
    const compactTitle = title.toLowerCase().replace(/\s+/g, ' ');
    // The normal ChatGPT landing page is reachable before authentication, but
    // it has no conversation composer. Treat its explicit login markers as a
    // human-authentication state instead of misclassifying it as a broken
    // reviewer page. This keeps the visible persistent browser open for the
    // operator and prevents recovery from entering a launch loop.
    const chatgptHost = (() => {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
          || hostname === 'chat.openai.com' || hostname.endsWith('.openai.com');
      } catch {
        return false;
      }
    })();
    const challengeMarkers = [];
    if (chatgptHost && !dom.composer) {
      if (/\bcloudflare\b|cf-chl-|cf-error|just a moment|verify you are human|performing security verification|checking your browser|enable javascript and cookies/.test(compactText)) {
        challengeMarkers.push('CLOUDFLARE_CHALLENGE');
      }
      if (/(?:\b502\b.*\bbad gateway\b|\bbad gateway\b.*\b502\b|\b503\b.*\bservice unavailable\b|\bservice unavailable\b.*\b503\b)/.test(`${compactTitle} ${compactText}`)) {
        challengeMarkers.push('HTTP_GATEWAY_CHALLENGE');
      }
    }
    if (challengeMarkers.length) {
      return healthResult('AUTH_REQUIRED', false,
        'HUMAN_AUTH_REQUIRED: Cloudflare challenge or gateway page requires human browser verification',
        {
          url,
          title,
          readyState: dom.readyState,
          authenticationRequired: true,
          browserChallenge: true,
          challengeMarkers,
        });
    }
    const humanAuthMarker = chatgptHost && !dom.composer && (
      /log in to get answers/.test(compactText)
      || /sign up for free/.test(compactText)
      || /continue with google/.test(compactText)
      || /log in to continue/.test(compactText)
    );
    if (humanAuthMarker) {
      return healthResult('AUTH_REQUIRED', false,
        'HUMAN_AUTH_REQUIRED: visible ChatGPT landing page requires authentication',
        { url, readyState: dom.readyState, authenticationRequired: true });
    }
    if (/\b(reconnecting|trying to reconnect|connection lost|reconnect to continue)\b/i.test(compactText)) {
      return healthResult('RECONNECTING', false, 'reviewer page reports a reconnect state', { url, text: bodyText.slice(0, 240) });
    }
    if (dom.online === false || /\b(waiting for network|waiting for connection|network unavailable|offline)\b/i.test(compactText)) {
      return healthResult('WAITING_NETWORK', false, 'reviewer page is waiting for network access', { url, online: dom.online });
    }
    if (dom.stopSelector) {
      return healthResult('GENERATING', true, 'visible stop-generation control is present', { url, selector: dom.stopSelector });
    }
    if (dom.composer && /(^https?:\/\/)?(chatgpt\.com|chat\.openai\.com)\//i.test(url)) {
      return healthResult('HEALTHY', false, 'reviewer composer is available', { url, readyState: dom.readyState });
    }
    return healthResult('UNREACHABLE', false, 'reviewer page is reachable but its conversation UI is unavailable', {
      url,
      readyState: dom.readyState,
      composer: dom.composer,
    });
  } catch (error) {
    const state = error?.code === 'REVIEWER_PROBE_TIMEOUT' ? 'UNREACHABLE' : 'DISCONNECTED';
    return healthResult(state, false, error?.code === 'REVIEWER_PROBE_TIMEOUT'
      ? 'reviewer health probe exceeded its deadline'
      : `reviewer page probe failed: ${error?.message || error}`);
  }
}

export async function findActualGeneration(page, options = {}) {
  const health = await classifyReviewerHealth(page, options);
  return {
    active: health.actualGeneration,
    evidence: health.evidence || { state: health.state, reason: health.reason },
    checkedAt: health.checkedAt,
  };
}

/** Validate the automation-owned tab budget without creating or closing tabs. */
export async function ensureBrowserPageBudget(context, {
  coordinatorPage = null,
  reviewerPages: reviewerPageInput = [],
  maxAutomationTabs = 3,
  maxReviewerTabs = 2,
} = {}) {
  const reviewers = reviewerPages(reviewerPageInput).filter(Boolean);
  const all = [coordinatorPage, ...reviewers].filter(Boolean);
  const unique = [...new Set(all)];
  let openPages = [];
  try {
    openPages = context?.pages?.().filter(page => !page.isClosed()) || [];
  } catch (error) {
    return { ok: false, pages: unique, automationTabCount: unique.length, reviewerTabCount: reviewers.length,
      reason: `browser page list unavailable: ${error.message || error}` };
  }
  const missing = unique.some(page => !openPages.includes(page));
  const automationTabCount = unique.length;
  const reviewerTabCount = new Set(reviewers).size;
  let reason = null;
  if (missing) reason = 'one or more owned pages are not present in the browser context';
  else if (reviewerTabCount > maxReviewerTabs) reason = `reviewer tab cap exceeded (${reviewerTabCount}/${maxReviewerTabs})`;
  else if (automationTabCount > maxAutomationTabs) reason = `automation tab cap exceeded (${automationTabCount}/${maxAutomationTabs})`;
  return { ok: reason === null, pages: unique, automationTabCount, reviewerTabCount, reason };
}

export function listRetiredReviewerTabs(buckets, openPageUrls) {
  const activeUrls = new Set();
  const retiredOwners = new Map();

  for (const [bucket, state] of Object.entries(buckets || {})) {
    const activeUrl = chatUrlKey(state?.chatUrl);
    if (activeUrl) activeUrls.add(activeUrl);

    for (const entry of state?.chatHistory || []) {
      const retiredUrl = chatUrlKey(entry?.chatUrl || entry?.url);
      if (retiredUrl && !retiredOwners.has(retiredUrl)) retiredOwners.set(retiredUrl, bucket);
    }
  }

  const seen = new Set();
  const retired = [];
  for (const url of openPageUrls || []) {
    const key = chatUrlKey(url);
    if (!key || activeUrls.has(key) || seen.has(key) || !retiredOwners.has(key)) continue;
    seen.add(key);
    retired.push({ bucket: retiredOwners.get(key), url });
  }
  return retired;
}
