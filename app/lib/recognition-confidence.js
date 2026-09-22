// Pure confidence checks. OCR preprocessing and the existing timer repair policy
// stay in recognize.js; these helpers only decide whether more evidence is needed.
const EPSILON = 1e-12;
const normalizeName = raw => String(raw || '').toLowerCase().replace(/[^a-zа-я\- ]/gi, '').trim();

function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

function createNameMatcher(dictionary, { threshold = 0.35, margin = 0.04, clearScore = 0.2 } = {}) {
  const entries = [...new Set(dictionary)].map(name => ({ name, normalized: normalizeName(name) }));
  // Sorting gives diagnostics a stable order; a tied score never produces a match.
  const compare = (a, b) => a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  function rank(raw) {
    const normalized = normalizeName(raw);
    let best = null, runnerUp = null;
    if (normalized.length >= 4) {
      for (const entry of entries) {
        const candidate = {
          name: entry.name,
          score: distance(normalized, entry.normalized) / Math.max(normalized.length, entry.normalized.length),
          raw,
        };
        if (!best || compare(candidate, best) < 0) { runnerUp = best; best = candidate; }
        else if (!runnerUp || compare(candidate, runnerUp) < 0) runnerUp = candidate;
      }
    }
    const gap = best && runnerUp ? runnerUp.score - best.score : Infinity;
    const acceptable = !!best && best.score <= threshold;
    const tied = acceptable && gap <= EPSILON;
    const exact = acceptable && best.score === 0 && !tied;
    const ambiguous = acceptable && !exact && (gap < margin || best.score > clearScore);
    return { best, runnerUp, gap, exact, ambiguous, match: acceptable && !tied ? best : null };
  }

  // Call only when the first reading needs review. A clear first result is kept:
  // collecting additional guesses must not overturn a clean name unnecessarily.
  // Special short/long Avalon twins still require the existing syllable check.
  function resolve(raws) {
    const readings = raws.slice(0, 3).map(rank);
    const first = readings[0];
    if (!first) return null;
    if (first.match && !first.ambiguous) return first.match;

    const exact = readings.filter(reading => reading.exact).map(reading => reading.match);
    const exactNames = new Set(exact.map(match => match.name));
    if (exactNames.size === 1) return exact[0];
    if (exactNames.size > 1) return null;

    const votes = new Map();
    for (const reading of readings) {
      if (!reading.match) continue; // A tie contributes no arbitrary winner.
      const match = reading.match;
      const group = votes.get(match.name) || { count: 0, match };
      group.count++;
      if (match.score < group.match.score) group.match = match;
      votes.set(match.name, group);
    }
    const groups = [...votes.values()].sort((a, b) => b.count - a.count);
    return groups[0]?.count >= 2 && groups[0].count > (groups[1]?.count || 0)
      ? groups[0].match : null;
  }
  return { rank, resolve };
}

function validTimer(vote) {
  return vote && Number.isFinite(vote.closes) && vote.closes >= 0 && vote.closes <= 24 * 3600
    && (vote.quality === 1 || vote.quality === 2);
}

function isCompleteTimer(vote) {
  return validTimer(vote) && (vote.complete === true || (vote.complete === undefined && vote.quality === 2));
}

// Compare before sameNumber merges values: that merge deliberately masks OCR
// disagreements such as 7/17 hours and 1/14 hours, which deserve a targeted read.
function timerConflict(votes) {
  const valid = votes.filter(validTimer);
  const complete = valid.filter(isCompleteTimer);
  if (complete.length) return new Set(complete.map(vote => vote.closes)).size > 1;
  const quality = Math.max(0, ...valid.map(vote => vote.quality));
  return new Set(valid.filter(vote => vote.quality === quality).map(vote => vote.closes)).size > 1;
}

// Targeted reads must come from the same closing-time line, using different
// preprocessing. Two agreeing complete durations may resolve an original conflict.
// A new value needs an explicit closing label; otherwise it may be the cooldown.
// Without that additional evidence, preserve the caller's existing repair policy.
function selectTimerReread(votes, targetedVotes, fallback) {
  if (!timerConflict(votes)) return fallback;
  const originalValues = new Set(votes.filter(validTimer).map(vote => vote.closes));
  const groups = new Map();
  const independent = new Map();
  for (const [index, vote] of targetedVotes.entries()) {
    if (!isCompleteTimer(vote)) continue;
    // Root supplies a stable key for each crop/preprocessing combination. Reusing
    // the same combination is one piece of evidence, even if OCR was run twice.
    const key = vote.evidenceKey ?? index;
    if (independent.has(key) && independent.get(key)?.closes !== vote.closes) independent.set(key, null);
    else if (!independent.has(key)) independent.set(key, vote);
  }
  for (const vote of [...independent.values()].filter(Boolean)) {
    const group = groups.get(vote.closes) || { count: 0, marker: false };
    group.count++;
    group.marker ||= !!vote.marker;
    groups.set(vote.closes, group);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  if (!ranked.length) return fallback;
  const [closes, group] = ranked[0];
  if (group.count < 2 || group.count <= (ranked[1]?.[1].count || 0)) return fallback;
  return originalValues.has(closes) || group.marker ? closes : fallback;
}

module.exports = { createNameMatcher, isCompleteTimer, timerConflict, selectTimerReread };
