'use strict';
module.exports = context => require('../../tools/build-privacy.cjs').checkAsar(require('node:path').join(context.appOutDir, 'resources', 'app.asar'));
