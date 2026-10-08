const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const i18n = require('../lib/i18n');
const routeImage = require('../ui/route-image');
require('../ui/search-line');
afterEach(() => i18n.setLanguage('ru'));

test('English messages preserve arbitrary names and literal placeholder characters', () => {
  i18n.setLanguage('en');
  assert.equal(i18n.t('Настройки'),'Settings');
  assert.equal(i18n.t('Портал в {0}. Нажми {1}.',['Хранитель $& {1}', 'F9']), 'Portal to Хранитель $& {1}. Press F9.');
  assert.equal(i18n.t('An unknown message {0}', ['Nomad']), 'An unknown message Nomad');
  assert.equal(i18n.locale(), 'en-US');
  assert.equal(i18n.setLanguage('unexpected'), 'ru');
  assert.equal(i18n.t('Настройки'),'Настройки');
});

test('English game names only affect presentation, including legacy mob and weapon labels', () => {
  const input = {name:'Авалонский копейщик',weapon:'Меч · T6.2'};
  i18n.setLanguage('en');
  assert.equal(i18n.gameName(input.name),'Avalonian Spearman');
  assert.equal(i18n.gameName('Моб #183'), 'Mob #183');
  assert.equal(i18n.gameName('Unknown nickname'), 'Unknown nickname');
  assert.equal(input.name, 'Авалонский копейщик');
  const names = require('../locales/game-names.en');
  const [ru, en] = Object.entries(names).find(([ru]) => ru.includes('меч'));
  assert.equal(i18n.gameName(ru+' · T6.2'), en+' · T6.2');
});

test('route exports switch their labels at runtime and use English plural rules for 21 steps', () => {
  i18n.setLanguage('en');
  const route={found:true,steps:Array.from({length:21},(_,i)=>({from:'Zone '+i,to:'Zone '+(i+1),kind:'walk'}))};
  const model=routeImage.plan(route, {'Zone 0':{color:'city'}}, Date.now());
  assert.match(model.summary,/^21 transitions/);
  assert.equal(model.nodes[0].zone.label,'City');
  assert.ok(!/[А-Яа-яЁё]/.test(JSON.stringify(model)));
  assert.equal(globalThis.SEARCH_LINE.parse('couexa 5h 36m').sec,20160);
  assert.equal(globalThis.SEARCH_LINE.fmtDur(20160),'5 h 36 min');
  assert.match(globalThis.SEARCH_LINE.parse('couexa 0').error,/greater than zero/);
  i18n.setLanguage('ru');
  assert.equal(routeImage.plan(route, {'Zone 0':{color:'city'}}, Date.now()).nodes[0].zone.label,'Город');
});

test('language option validates, saves and broadcasts to all open windows without touching other options', () => {
  const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const code=source.slice(source.indexOf('const OPTIONS = {'),source.indexOf('// ---------- комнаты ----------'));
  let handler, saves=0;
  const config={language:'ru',theme:'coal',saveLocal:true,overlayEnabled:true};
  const messages=[];
  const primary={isDestroyed:()=>false,webContents:{send:(...args)=>messages.push(args)},setTitle() {}};
  const overlay={isDestroyed:()=>false,webContents:{send:(...args)=>messages.push(args)}};
  const context=vm.createContext({config,win:primary,profile:{title:'Avalon Mapper'},i18nText:i18n.t,require:()=>i18n,
    ipcMain:{handle:(name,fn)=>{if(name==='set-option')handler=fn;}},
    BrowserWindow:{getAllWindows:()=>[primary,overlay]},configForWindow:()=>({...config}),
    flushConfig(){},saveConfig(){saves++;},console});
  vm.runInContext(code,context);
  assert.equal(handler({},'language','arbitrary').language,'ru');
  assert.equal(saves,0);assert.equal(messages.length,0);
  const result=handler({},'language','en');
  assert.equal(result.language,'en');assert.equal(saves,1);
  assert.deepEqual(messages,[['language-changed','en'],['language-changed','en']]);
  assert.equal(config.theme,'coal');assert.equal(config.saveLocal,true);
});

test('each secure preload exposes only the two fixed locale channels and can unsubscribe', () => {
  for(const name of ['preload','preload-overlay','preload-metrics','preload-search','preload-picker']){
    const exposed={},events=new Map(),sent=[];
    const ipc={sendSync:name=>{sent.push(name);return 'en';},on:(name,fn)=>events.set(name,fn),removeListener:(name,fn)=>{if(events.get(name)===fn)events.delete(name);}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../'+name+'.js'),'utf8'),{
      require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}},ipcRenderer:ipc})});
    assert.deepEqual(sent,['get-language']);assert.equal(exposed.appLocale.language,'en');
    assert.deepEqual(Object.keys(exposed.appLocale),['language','onChange']);
    let received;const unsubscribe=exposed.appLocale.onChange(value=>{received=value;});
    events.get('language-changed')({},'ru');assert.equal(received,'ru');unsubscribe();
    assert.equal(events.has('language-changed'),false);
  }
});
