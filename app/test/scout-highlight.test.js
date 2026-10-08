const {test}=require('node:test'),assert=require('node:assert/strict'),cytoscape=require('cytoscape');
require('../ui/scout-highlight');
test('content filter marks the current graph, supports no matches and clears without removing a route',()=>{
 const cy=cytoscape({headless:true,elements:[{data:{id:'Ore'}},{data:{id:'Chest'}},{data:{id:'Other'}},{data:{id:'Link',source:'Ore',target:'Other'}}]});
 try{
 const h=globalThis.SCOUT_HIGHLIGHT.create(cy);cy.$id('Other').addClass('route-hit');cy.$id('Link').addClass('route-hit');
 h.set(['Ore','Not on this map']);assert.equal(cy.$id('Ore').hasClass('scout-match'),true);assert.equal(cy.$id('Chest').hasClass('scout-dim'),true);
 assert.equal(cy.$id('Other').hasClass('route-hit'),true);assert.equal(cy.$id('Link').hasClass('route-hit'),true);
 cy.add({data:{id:'New'}});h.paint();assert.equal(cy.$id('New').hasClass('scout-dim'),true);
 h.set([]);assert.equal(cy.nodes('.scout-match').length,0);assert.equal(cy.nodes('.scout-dim').length,4);
 h.clear();assert.equal(cy.elements('.scout-dim,.scout-match').length,0);assert.equal(cy.$id('Other').hasClass('route-hit'),true);
 }finally{cy.destroy();}
});
test('real graph styles keep route and content matches bright together and recover after clearing',()=>{
 const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
 const window={},context={window,document:{documentElement:{}},getComputedStyle:()=>({getPropertyValue:()=>'#aaaaaa'})};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/graph-style.js'),'utf8'),context);
 const cy=cytoscape({headless:true,styleEnabled:true,style:[...JSON.parse(JSON.stringify(window.GRAPH_STYLE)),{selector:'*',style:{'transition-property':'none','transition-duration':0}}],elements:[{data:{id:'Ore',label:'Ore',color:'#fff'}},{data:{id:'Route',label:'Route',color:'#fff'}},{data:{id:'Other',label:'Other',color:'#fff'}}]});
 try{
 const h=globalThis.SCOUT_HIGHLIGHT.create(cy);cy.$id('Ore').addClass('route-dim');cy.$id('Route').addClass('route-hit');
 h.set(['Ore']);assert.equal(cy.$id('Ore').style('opacity'),'1');assert.equal(cy.$id('Route').style('opacity'),'1');assert.equal(cy.$id('Other').style('opacity'),'0.14');
 h.clear();assert.equal(cy.$id('Ore').style('opacity'),'0.1');assert.equal(cy.$id('Route').style('opacity'),'1');
 }finally{cy.destroy();}
});
