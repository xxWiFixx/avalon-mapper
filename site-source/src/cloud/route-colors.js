// Use the graph's zone palette for route markers as the desktop map does.
export function routeMarkerColor(zones, name, palette) {
  const color = zones?.[name]?.color;
  return color && Object.hasOwn(palette || {}, color) ? palette[color] : undefined;
}
