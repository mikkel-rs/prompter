// Pure alignment logic. No DOM, no I/O. Shared by every STT backend.
//
// The problem: we get a noisy, rolling hypothesis of what the speaker just
// said. We know roughly where they are in the script (the cursor). Find the
// script position that best explains the tail of the hypothesis, without
// jumping around on single-word noise, and without moving at all on silence.

const WORD_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

export function normalizeWord(w) {
  return w
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/-/g, "");
}

// Split text into tokens with character spans so the UI can map back.
export function tokenizeScript(text) {
  const tokens = [];
  for (const m of text.matchAll(WORD_RE)) {
    tokens.push({
      display: m[0],
      norm: normalizeWord(m[0]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tokens;
}

export function tokenizeHypothesis(text) {
  const out = [];
  for (const m of text.matchAll(WORD_RE)) out.push(normalizeWord(m[0]));
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

// 0..1 similarity between two normalized words.
export function similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Whisper often drops or adds inflection endings; a long shared prefix is a match.
  if (maxLen >= 5) {
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (longer.startsWith(shorter) && shorter.length >= 4 && shorter.length / longer.length >= 0.6) return 0.85;
  }
  return 1 - levenshtein(a, b) / maxLen;
}

export const DEFAULTS = {
  tail: 6,          // hypothesis words considered
  back: 30,         // how far behind the cursor we search (re-reading a sentence)
  ahead: 40,        // how far ahead we search
  matchThreshold: 0.7,
  minMatches: 3,    // fewer matched words than this never moves the cursor
  backPenalty: 1.5, // extra score a backward move needs
  gap: 0.5,         // cost of skipping a script word or an extra hyp word
};

// Score how well `hyp` (array of norm words) aligns to the script slice ending
// at index `end` (inclusive). Leading script words are free (we do not care where
// the hypothesis begins). script[end] must be matched; hyp words after that match
// may be unmatched (a half-spoken word, noise), so the cursor lands on the last
// script word the speaker actually reached.
// Operations: match, gap (skip a script word / extra hyp word), merge2 (two hyp
// words -> one script word, Whisper splitting compounds), split2 (one hyp word ->
// two script words, Whisper joining them). Returns {score, matches}.
function scoreEndingAt(script, hyp, end, opts) {
  const K = hyp.length;
  const from = Math.max(0, end - K - 3 + 1);
  const seg = script.slice(from, end + 1);
  const n = seg.length, m = K;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const cnt = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  const endsMatched = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let j = 1; j <= m; j++) dp[0][j] = -opts.gap * j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = -Infinity, c = 0, em = 0;
      const consider = (score, count, matched) => {
        if (score > best + 1e-9) { best = score; c = count; em = matched; }
      };
      const sim = similarity(seg[i - 1].norm, hyp[j - 1]);
      if (sim >= opts.matchThreshold) consider(dp[i - 1][j - 1] + sim, cnt[i - 1][j - 1] + 1, 1);
      else consider(dp[i - 1][j - 1] - opts.gap, cnt[i - 1][j - 1], 0);
      // Skip a script word: the path no longer ends on a matched script word.
      consider(dp[i - 1][j] - opts.gap, cnt[i - 1][j], 0);
      // Extra hyp word (noise, half-spoken word): keep whatever the script side ended on.
      consider(dp[i][j - 1] - opts.gap, cnt[i][j - 1], endsMatched[i][j - 1]);
      // Merge/split only when the joined form explains the words better than the plain match.
      if (j >= 2) {
        const s2 = similarity(seg[i - 1].norm, hyp[j - 2] + hyp[j - 1]);
        if (s2 >= opts.matchThreshold && s2 > sim) consider(dp[i - 1][j - 2] + s2, cnt[i - 1][j - 2] + 2, 1);
      }
      if (i >= 2) {
        const s3 = similarity(seg[i - 2].norm + seg[i - 1].norm, hyp[j - 1]);
        if (s3 >= opts.matchThreshold && s3 > sim) consider(dp[i - 2][j - 1] + s3, cnt[i - 2][j - 1] + 1, 1);
      }
      dp[i][j] = best; cnt[i][j] = c; endsMatched[i][j] = em;
    }
  }
  if (!endsMatched[n][m]) return { score: -Infinity, matches: 0 };
  return { score: dp[n][m], matches: cnt[n][m] };
}

// Returns {cursor, score, matches} or null when the position should not move.
// `cursor` is the index of the script word currently being spoken (-1 = not started).
export function align(script, hypWords, cursor, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!script.length || !hypWords.length) return null;
  const hyp = hypWords.slice(-opts.tail);
  if (hyp.length < Math.min(opts.minMatches, script.length)) return null;

  const lo = Math.max(0, cursor - opts.back);
  const hi = Math.min(script.length - 1, cursor + opts.ahead);
  let best = null;
  for (let end = lo; end <= hi; end++) {
    const { score, matches } = scoreEndingAt(script, hyp, end, opts);
    if (matches < Math.min(opts.minMatches, hyp.length)) continue;
    // Backward moves need to earn it; forward ties prefer the nearer position.
    let adjusted = score;
    if (end < cursor) adjusted -= opts.backPenalty;
    if (!best || adjusted > best.adjusted + 1e-9) {
      best = { cursor: end, score, matches, adjusted };
    }
  }
  if (!best) return null;
  // Require at least half of the hypothesis tail to have matched.
  if (best.matches < Math.ceil(hyp.length / 2)) return null;
  return { cursor: best.cursor, score: best.score, matches: best.matches };
}

// Convenience for the UI: words around the cursor to bias the decoder.
export function contextAround(script, cursor, before = 10, after = 30) {
  const lo = Math.max(0, cursor - before);
  const hi = Math.min(script.length, cursor + after);
  return script.slice(lo, hi).map((t) => t.display).join(" ");
}
