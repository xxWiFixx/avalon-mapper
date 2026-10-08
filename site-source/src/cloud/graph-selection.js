export function syncGraphSelection(cy, name) {
  if (!cy) return;
  cy.nodes().unselect();
  const node = name ? cy.$id(name) : null;
  if (node?.length) node.select();
}
