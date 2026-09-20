function chatUrlKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return null;
  }
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
