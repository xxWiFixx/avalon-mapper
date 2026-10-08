// Filter marks are independent of route classes: clearing either preserves the other.
(function(root){
  function create(cy){
    let names=null;
    function paint(){
      cy.batch(()=>{
        cy.elements().removeClass('scout-match scout-dim');
        if(names===null)return;
        cy.nodes().forEach(n=>n.addClass(names.has(n.id())?'scout-match':'scout-dim'));
        cy.edges().addClass('scout-dim');
      });
    }
    return {set(matches){names=new Set(matches);paint();},clear(){names=null;paint();},paint};
  }
  root.SCOUT_HIGHLIGHT={create};
})(typeof window==='undefined'?globalThis:window);
