# Context terms

This file is the shared vocabulary for the arah restart. The code owns the exact schemas. This file only disambiguates words.

## Utterance terms

- **RideIntention.** The raw sentence a rider types. Untrusted. It exists only at the HTTP and parse boundary.
- **Utterance.** Same as RideIntention. `"long ride at alsut 150 min"` is an utterance.
- **Unreadable.** An utterance the parser cannot turn into a RouteRequest. Empty text and `"asdf"` are unreadable. Unreadable is always `IntentionUnreadable`, never a default plan.

## Parse terms

- **LLM parse.** The primary language-model path. It calls `model.generateObject` with schema `LlmRideParse`. This is JSON-schema constrained structured output generation as studied in [Meaning Typed Prompting](https://arxiv.org/abs/2410.18146), [TOON vs JSON](https://arxiv.org/abs/2603.03306), and [Structured Output Benchmark](https://arxiv.org/abs/2604.25359). It needs a `LanguageModel` service in the Effect context.
- **Table parser.** The deterministic fallback in `src/parseIntention.ts`. It only runs when the model key is missing or `AiUnavailable` escapes. It produces an `LlmRideParse` directly with no `LanguageModel` requirement.
- **Escape.** A node failure route that keeps the planner alive. `AiUnavailable` escapes to the table parser. Live weather misses become `unavailable` coverage instead of blocking the ride.
- **Sabotage path.** The plan uses this word once as "escape" in the graph. Treat sabotage and escape as the same thing here.

## Route terms

- **GraphHopper.** The live Go router of choice. Bike profile HTTP service at `GRAPHHOPPER_URL`.
- **OSRM fallback.** Public OSRM cycling used when GraphHopper is not configured or fails.
- **Curated GPX fallback.** Fixed geometry from `data/routes.json` for known pairs when both live engines fail.
- **Direct fallback.** A straight two-point line used when every other router fails.
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