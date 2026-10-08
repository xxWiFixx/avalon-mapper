'use strict';

// Временный локальный архив попыток распознавания порталов. Он не участвует в
// распознавании и не отправляет кадры на сервер: запись идёт после захвата.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const sharp = require('sharp');
const F = require('./frame');

function failureReasons({ tip = null, blank = false, error = null, skipped = null } = {}) {
  if (blank) return ['blank_capture'];
  if (error) return ['recognition_error'];
  if (skipped) return ['recognition_skipped'];
  const reasons = [];
  if (!tip?.name) reasons.push('portal_zone_unread');
  else {
    if (tip.closes == null || tip.timerUncertain) reasons.push('timer_unread');
    if (tip.capMax == null || tip.capMaxKnown === false) reasons.push('capacity_unread');
  }
  return reasons;
}

async function encodePng(frame) {
  return sharp(F.toRGBA(frame), { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .png({ compressionLevel: 3 }).toBuffer();
}

function createPortalShotArchive(root, { files = fs.promises, encode = encodePng,
  now = Date.now, uid = randomUUID, onError = err => console.error('[архив порталов]', err) } = {}) {
  const allDir = path.join(root, 'all');
  const failedDir = path.join(root, 'failed');
  let chain = Promise.resolve();
  const run = job => {
    chain = chain.then(job).catch(err => { onError(err); return null; });
    return chain;
  };

  function capture({ portalFrame, zoneFrame = null, capturedAt = now(), source = null,
    originAtCapture = null, screenHeight = null, cursor = null }) {
    if (!portalFrame) return null;
    const stamp = new Date(capturedAt).toISOString().replace(/[:.]/g, '-');
    const id = `${stamp}_${uid().slice(0, 8)}`;
    const portalFile = `${id}_portal.png`;
    const zoneFile = zoneFrame ? `${id}_current-zone.png` : null;
    const saved = run(async () => {
      await files.mkdir(allDir, { recursive: true });
      await files.writeFile(path.join(allDir, portalFile), await encode(portalFrame));
      if (zoneFrame) await files.writeFile(path.join(allDir, zoneFile), await encode(zoneFrame));
      return true;
    });
    return {
      id,
      finish(outcome = {}) {
        return run(async () => {
          if (!await saved) return null;
          const reasons = failureReasons(outcome);
          const tip = outcome.tip || null;
          const zone = outcome.zone || null;
          const record = {
            id, capturedAt: new Date(capturedAt).toISOString(), source, originAtCapture,
            capture: { width: portalFrame.width ?? null, height: portalFrame.height ?? null, screenHeight, cursor },
            images: { portal: portalFile, currentZone: zoneFile }, reasons,
            result: {
              portalZone: tip?.name || null, currentZone: zone?.zone || null,
              usedSlots: tip?.capNum ?? null, totalSlots: tip?.capMax ?? null,
              slotsEstimated: !!tip?.capNumApprox, remainingSeconds: tip?.closes ?? null,
              timerUncertain: !!tip?.timerUncertain,
            },
            raw: tip?.raw || null,
            error: outcome.error || outcome.skipped || null,
          };
          const jsonFile = `${id}.json`;
          const json = JSON.stringify(record, null, 2);
          await files.writeFile(path.join(allDir, jsonFile), json);
          if (reasons.length) {
            await files.mkdir(failedDir, { recursive: true });
            await files.copyFile(path.join(allDir, portalFile), path.join(failedDir, portalFile));
            if (zoneFile) await files.copyFile(path.join(allDir, zoneFile), path.join(failedDir, zoneFile));
            await files.writeFile(path.join(failedDir, jsonFile), json);
          }
          return record;
        });
      },
    };
  }

  return { capture, allDir, failedDir };
}

module.exports = { createPortalShotArchive, failureReasons };
