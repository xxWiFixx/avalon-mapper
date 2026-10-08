'use strict';
// Research-only joint policy. Refined after the first retrospective full run:
// a zero omitted at the start of the minor unit does not change its value.
const known = value => Number.isFinite(value);
function withoutSpaces(text) { return String(text || '').replace(/\s+/g, '').toLowerCase().replace(/h/g, 'ч').replace(/m/g, 'м').replace(/[cs]/g, 'с'); }
function onlyMinorZeroMissing(shortText, fullText) {
  const short = withoutSpaces(shortText).match(/^(\d{1,2})(ч|м)(\d)(м|с)$/u);
  const full = withoutSpaces(fullText).match(/^(\d{1,2})(ч|м)(0\d)(м|с)$/u);
  return !!short && !!full && ['чм', 'мс'].includes(full[2] + full[4])
    && short[1] === full[1] && short[2] === full[2] && short[4] === full[4] && '0' + short[3] === full[3];
}
function combine(baseline, methods) {
  const value = baseline?.closes ?? null;
  if (baseline?.raw?.timerRegion?.kind === 'red') return { proposal: value, reason: 'existing-red-verification' };
  const c = methods.completeness, g = methods.glyph, full = methods.glyphFullCrop;
  let proposal = c?.decision === 'accept' ? c.proposal : c?.decision === 'reject' ? null : value;
  let reason = c?.decision === 'reject' ? c.reason : c?.decision === 'accept' ? c.reason : 'baseline-retained-unverified';
  const conflict = candidate => known(candidate) && ((known(g?.proposal) && g.proposal !== candidate)
    || (known(full?.proposal) && full.proposal !== candidate));
  const fullText = withoutSpaces(full?.diagnostics?.text);
  const zeroConfirmed = c?.decision === 'reject' && c.reason === 'baseline-leaves-visible-glyphs-unread'
    && c.diagnostics?.stable && known(value) && full?.proposal === value && !conflict(value)
    && fullText.length === c.diagnostics.glyphCount
    && c.diagnostics.observedTokens?.some(t => t.sec === value && onlyMinorZeroMissing(t.text, fullText));
  if (zeroConfirmed) { proposal = value; reason = 'minor-zero-confirmed-by-full-pixel-reading'; }
  if (conflict(proposal)) return { proposal: null, reason: 'pixel-value-conflicts-with-ocr' };
  if (known(proposal) && proposal !== value && (full?.proposal ?? g?.proposal) !== proposal) {
    return { proposal: null, reason: 'new-value-needs-pixel-confirmation' };
  }
  return { proposal, reason };
}
module.exports = { combine, onlyMinorZeroMissing };
