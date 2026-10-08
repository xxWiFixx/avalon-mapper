const resourceTypes = new Set(['ore', 'fiber', 'hide', 'wood', 'rock']);

export function contentAmount(zone, goal) {
  if (!zone || (goal.tier && Number(zone.tier) !== Number(goal.tier))) return 0;
  const resource = key => Math.max(0, Number(zone.res?.[key]?.n) || 0);
  const chest = key => Math.max(0, Number(zone.chests?.[key]) || 0);
  if (resourceTypes.has(goal.type)) return resource(goal.type);
  if (goal.type === 'any-resource') return [...resourceTypes].reduce((sum, type) => sum + resource(type), 0);
  const blue = chest('blueSmall') + chest('blueBig');
  const gold = chest('goldSmall') + chest('goldBig');
  const green = chest('green');
  if (goal.type === 'blue') return blue;
  if (goal.type === 'gold') return gold;
  if (goal.type === 'green') return green;
  return goal.type === 'any-chest' ? blue + gold + green : 0;
}

export function contentMatches(zones, openNames, goals, match = 'any') {
  if (!Array.isArray(goals) || !goals.length) return [];
  return [...new Set(openNames)].filter(name => {
    const zone = zones[name];
    if (!zone) return false;
    const counts = goals.map(goal => contentAmount(zone, goal));
    return match === 'all' ? counts.every(count => count > 0) : counts.some(count => count > 0);
  });
}
