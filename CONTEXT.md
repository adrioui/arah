# Context terms

This file is the shared vocabulary for the arah restart. The code owns the exact schemas. This file only disambiguates words.

## Utterance terms

- **RideIntention.** The raw sentence a rider types. Untrusted. It exists only at the HTTP and parse boundary.
- **Utterance.** Same as RideIntention. `"long ride at alsut 150 min"` is an utterance.
- **Unreadable.** An utterance the parser cannot turn into a RouteRequest. Empty text and `"asdf"` are unreadable. Unreadable is always `IntentionUnreadable`, never a default plan.

## Parse terms

- **Table parser.** The deterministic parser in `src/parseIntention.ts`. It matches the golden utterance patterns and produces an `LlmRideParse` directly. It runs with no `LanguageModel` requirement.
- **LLM parse.** The language-model path. It calls `model.generateObject` with schema `LlmRideParse`, then converts to `RouteRequest`. It needs a `LanguageModel` service in the Effect context.
- **Escape.** A node failure route that keeps the planner alive. `AiUnavailable` escapes to the table parser. Live weather misses become `unavailable` coverage instead of blocking the ride.
- **Sabotage path.** The plan uses this word once as "escape" in the graph. Treat sabotage and escape as the same thing here.

## Route terms

- **Curated GPX.** The Go router. Point-to-point rides read fixed geometry from `data/routes.json`. No live routing engine runs in this deploy.
- **GraphHopper.** Lives outside the Worker-shaped deploy. It is an offline tool for producing future GPX, not a request-time dependency.
- **Lushu.** The curated static loops that Train rides use. They are not generated per ride.
- **Candidate route.** A concrete ridable geometry with distance, climb, lane, lighting, and a `routeSource` literal.

## Weather terms

- **Nowcast.** Open-Meteo hourly forecast read at ride time for one point. It becomes an `Observation` with `source: "nowcast"` and a small bbox around the origin or venue. This is the real-time weather node.
- **Flood.** PetaBencana live flood polygons. It is already the live flood adapter.
- **BMKG bulletin.** Fixtures only. Live BMKG parsing is unwritten. The fixture rows may be present or stale, and never gate the plan alone.
- **Coverage.** A claim about whether a source can see the ride area. `covered`, `not-covered`, `stale`, or `unavailable`.
- **Unavailable means what it says.** A failed nowcast covers nothing and says `unavailable`. It does not pretend the sky is clear.

## Decision terms

- **DecisionOutput.** The one value the server returns for one plan. It contains ranked routes, candidate geometries, resolved places, and coverage facts.
- **decide.** The pure ranking function. No IO, no clock. It sorts candidates by verdict and evidence.
- **Fit.** The training-loop lap math layered on top of decide for Train rides.