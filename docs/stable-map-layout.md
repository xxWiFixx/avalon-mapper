# Stable map positions

New zones use `GRAPH_LAYOUT.incremental` from `app/ui/graph-layout.js`. Existing
coordinates never participate in automatic force layout. Candidate positions are
scored against node/name bounds, existing edges, crossings and timer-label bounds.
Timer updates, new links between existing nodes and expired portals do not move
surviving nodes. A full compact rearrangement is an explicit action only.

`app/ui/stable-map-layout.js` persists positions by account and channel. It checks
`map_layout_since(p_map, p_revision)` for changes and calls
`map_layout(p_map, p_positions, p_revision, p_replace)` to serialize competing writes.
An unchanged read returns only the revision, without coordinates, row creation or a
writer lock. Confirmed server positions are held separately from locally calculated
positions so a failed upload is retried after the normal backoff. Older databases
automatically fall back to `map_layout` reads. Existing server positions win;
rejected new proposals are recalculated on a conflict. The owner and verified members may replace an entire
shared layout. Members may initialize missing coordinates for actual zones on their
map, but viewers are read-only after migration 19. Access is checked
on every RPC, including group subscription status. Tables have RLS and no direct
client grants. Local fallback remains usable offline or against an older backend.

Cloud recovery can reconcile provisional offline coordinates to another device's
already saved positions. Explicit owner rearrangements also update other devices.
These are the exceptions to stationary coordinates; ordinary portal additions do
not rearrange the map. Crossings in a dense or non-planar network remain possible.

The desktop preserves pan/zoom on updates; switching channels fits the saved map.
Group nodes cannot be dragged. Manual personal-map dragging persists coordinates;
shared full reset failures are reported, with the displayed layout restored.
An active desktop or visible website map checks coordinates at most once per five
seconds, or immediately when topology changes. Hidden windows/tabs stop polling.
An unchanged desktop check does not redraw Cytoscape; the website avoids rewriting
unchanged nodes and edges during its timer refresh. The website's separate portal
snapshot refresh remains 15 seconds. The new read RPC is installed by migration 20;
until it exists, clients keep working but use the previous full-read path.

Load model: one continuously active client performs at most 12 layout checks per
minute; 50 concurrent clients would produce up to 10 checks/second and 100 up to
20 checks/second. One player with both desktop and website open counts as two
clients. These are request counts, not a production capacity guarantee. Record
actual concurrent clients, read latency and error rate before changing the interval
or plan. If concurrency becomes much higher, replace polling with private Realtime
Broadcast notifications plus an occasional revision check for recovery.

Deployment: on 2026-09-29 the user reported `Success. No rows returned` for
`supabase/migration-17-stable-map-layout.sql`. An anonymous read-only probe of the
live RPC returned 401 / 42501 `permission denied for function map_layout`, confirming
the function exists and rejects unauthenticated requests. Authenticated production
round-trip verification is still pending; schema, access control and concurrency
are covered by isolated PostgreSQL tests. Migration 19 was applied to the live
project on 2026-09-30; a separate read-only query confirmed the
`map_layout_write_guard` trigger is installed. The live GENIUS group had
57 active edges, 86 active zones and 146 stored coordinates at that time;
all active zones had stored coordinates. A two-account viewer/writer round trip
and visual app/site comparison remain pending.

Migration 20 was applied in the live SQL Editor on 2026-09-30 (`Success. No rows
returned`). Isolated PostgreSQL tests verify unchanged/full responses, member and
subscription checks, and missing-row behavior. Two live clients have not yet been
timed after the migration.

Validation: `npm run test:layout` from `app` and `npm test` plus `npm run build`
from `site-source`. The UI tests run production rendering
with Cytoscape, checking old coordinates, camera and stale-channel responses.
The local `?layout-review` fixture uses the production renderer with 100 generated
zones / 109 links, then adds 50 zones (150 / 164 total). On the test PC the first
addition took 110 ms, moved 0/100 old nodes and preserved the camera. One-node
insertion into a synthetic 1000-node graph measured about 20–22 ms; timings depend
on graph density and hardware, and do not include network latency.
