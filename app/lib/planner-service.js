'use strict';
const {Worker}=require('node:worker_threads'),path=require('node:path');
let active=0;
function plan(snapshot,request,options){
  if(active>=2)return Promise.reject(new Error('Дождись завершения поиска.'));
  active++;
  return new Promise((resolve,reject)=>{
    let worker,timer,done=false;
    const finish=(error,result)=>{if(done)return;done=true;active--;clearTimeout(timer);worker?.terminate();error?reject(error):resolve(result);};
    try {
      worker=new Worker(path.join(__dirname,'planner-worker.js'),{workerData:{snapshot,request,options}});
      timer=setTimeout(()=>finish(new Error('Слишком сложный маршрут. Уменьши число целей.')),15000);
      worker.once('message',m=>finish(m.error?new Error(m.error):null,m.result));
      worker.once('error',e=>finish(e));
      worker.once('exit',()=>{if(!done)finish(new Error('Поиск маршрута прерван.'));});
    }catch(error){finish(error);}
  });
}
module.exports={plan};
