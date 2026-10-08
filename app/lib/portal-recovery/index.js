'use strict';
// Complete white-timer verification and conservative card recovery. The caller
// owns the OCR worker and provides pure helpers; this module never imports the
// top-level recognizer, opens an archive, or uses previous-frame answers.
function createRecovery(helpers) {
  if (!helpers || !Array.isArray(helpers.DICT) || typeof helpers.NAME_TWINS?.has !== 'function')
    throw new TypeError('Portal dictionary helpers are required');
  for (const name of ['resolveTwin', 'zoneInfo', 'findBarCands', 'crop']) {
    if (typeof helpers[name] !== 'function') throw new TypeError('Missing portal helper: ' + name);
  }
  const completeness = require('./completeness');
  const glyph = require('./glyph-verifier');
  const v3 = require('./pipeline-v3');
  const v5 = require('./pipeline-v5').createPipeline(helpers);
  const validSeconds = value => Number.isInteger(value) && value >= 0 && value <= 86400;

  async function recover(frame, baseline, {
    ocr, screenHeight = 0, excludeEpisode = null, onName = null, includeDiagnostics = false,
  } = {}) {
    const methods = {}, bar = baseline?.raw?.bar;
    if (bar && baseline.raw.timerRegion?.kind !== 'red') {
      methods.completeness = await completeness.verify(frame, bar, {
        ocr, baseline, timerRegion: baseline.raw.timerRegion, reads: baseline.raw.timerReads || [],
      });
      methods.glyph = await glyph.recognize(frame, bar, { excludeEpisode });
      const full = methods.completeness.diagnostics?.fullBox;
      if (full && methods.completeness.diagnostics.stable) {
        methods.glyphFullCrop = await glyph.recognize(frame, bar, {
          excludeEpisode, timerRegion: { ...full, kind: 'light' },
        });
      }
    } else if (!bar) {
      methods.completeness = { proposal: null, decision: 'unknown', reason: 'portal-not-confirmed' };
      methods.glyph = { proposal: null, reason: 'portal-not-confirmed', glyphs: [], diagnostics: {} };
    }
    const v3Result = await v3.evaluate(frame, baseline, methods, { ocr, excludeEpisode });
    const v5Result = await v5.evaluate(frame, baseline, methods, v3Result.final, {
      ocr, screenHeight, excludeEpisode, onName,
    });
    let proposal = validSeconds(v5Result.final?.proposal) ? v5Result.final.proposal : null;
    const recoveredCard = v5Result.card?.decision === 'accept'
      && v5Result.card.portal?.name === v5Result.portalName
      && helpers.DICT.includes(v5Result.card.portal?.name)
      && ['bx', 'by', 'bh'].every(key => Number.isFinite(v5Result.card.portal?.raw?.bar?.[key]))
      && v5Result.card.portal.raw.bar.bh > 0
      && !['card-not-confirmed', 'invalid-card-geometry', 'portal-name-not-confirmed'].includes(v5Result.stage);
    const sourcePortal = recoveredCard ? v5Result.recoveredV3?.baseline || v5Result.card.portal : baseline;
    let detail = null;
    if(proposal===null&&sourcePortal){
      detail=await require('./detail-recovery').recover(frame,sourcePortal,
        recoveredCard?v5Result.recoveredV3?.methods||methods:methods,
        recoveredCard?v5Result.recoveredV3?.result?.segmentation:v3Result.segmentation,
        {...v5Result.final,points:[v3Result.point,v5Result.recoveredV3?.result?.point,
          v5Result.timer?.diagnostics?.point,v5Result.timer?.diagnostics?.originalPoint]},{ocr});
      if(detail.decision==='accept'&&validSeconds(detail.proposal)){
        proposal=detail.proposal;v5Result.final={proposal,reason:detail.reason};v5Result.stage='detail-recovered';
      }
    }
    const retainedUnverified = v5Result.final?.reason === 'baseline-retained-unverified';
    const portal = sourcePortal ? {
      ...sourcePortal,
      closes: proposal,
      timerUncertain: proposal === null || retainedUnverified && sourcePortal.timerUncertain === true,
    } : null;
    const diagnostics = {
      version: 5,
      stage: v5Result.stage,
      reason: v5Result.final?.reason || v5Result.stage,
      proposal,
      previousSeconds: baseline?.closes ?? null,
      excludedEpisode: excludeEpisode,
      cardRecovered: !!recoveredCard,
      v3Stage: v3Result.stage,
    };
    if (includeDiagnostics) Object.assign(diagnostics, { methods, v3: v3Result, v5: v5Result, detail });
    return { portal, diagnostics };
  }
  return { recover };
}

module.exports = { createRecovery };
