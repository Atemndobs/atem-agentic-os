// Scrub obvious secrets and identifiers out of a digest.
//
// This runs on EVERY digest at build time, not only before sending, so the
// on-disk dataset is already safe to inspect, diff and share. It is a coarse
// net, not a guarantee: review a sample before you enable --send.

const RULES = [
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, "<KEY>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<AWS_KEY>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<GH_TOKEN>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<SLACK_TOKEN>"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<JWT>"],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer <TOKEN>"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<EMAIL>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<IP>"],
  [/\/Users\/[^/\s"']+/g, "~"],
  // Long opaque blobs: hex digests, base64 payloads, raw entropy.
  [/\b[a-f0-9]{32,}\b/gi, "<HEX>"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<BLOB>"],
];

export function redact(text) {
  if (typeof text !== "string") return "";
  let out = text;
  for (const [re, sub] of RULES) out = out.replace(re, sub);
  return out;
}

/** Count how many substitutions a string would take. Used for reporting. */
export function redactionHits(text) {
  if (typeof text !== "string") return 0;
  let n = 0;
  for (const [re] of RULES) n += (text.match(re) || []).length;
  return n;
}
