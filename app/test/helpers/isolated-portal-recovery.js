'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
// A fresh production module graph lets tests replace individual collaborators
// without sharing those replacements with other cases. No candidate code loads.
function loadRecovery(){
 const directory=path.resolve(__dirname,'../../lib/portal-recovery'),cache=new Map();
 function load(filename){
  if(cache.has(filename))return cache.get(filename).exports;
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));cache.set(filename,m);
  const normal=m.require.bind(m);
  m.require=id=>{
   if(id.startsWith('.')){const resolved=Module._resolveFilename(id,m);if(resolved.startsWith(directory+path.sep))return load(resolved);}
   return normal(id);
  };
  m._compile(fs.readFileSync(filename,'utf8'),filename);m.loaded=true;return m.exports;
 }
 return {recovery:name=>load(path.join(directory,name+'.js'))};
}
module.exports={loadRecovery};
