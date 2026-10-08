'use strict';
const {parentPort,workerData}=require('node:worker_threads');
require('./i18n').setLanguage(workerData.options.language);
const content=require('./content-search'),router=require('./router');
try {
  const {snapshot,request,options}=workerData;
  const snap=content.scoped(snapshot,request.scope,options.now);
  const goalSets=request.goals?.length?content.goalSets(snap,{...request,now:options.now}):[];
  const result=router.findPlan(snap,request.from,{to:request.to,waypoints:request.waypoints,goalSets},options);
  if(request.match==='all'&&result.reasonCode==='missing-content')result.reason=require('./i18n').t('На открытой карте нет зоны со всеми выбранными условиями.');
  parentPort.postMessage({result});
}catch(error){parentPort.postMessage({error:require('./i18n').t(error.message)});}
