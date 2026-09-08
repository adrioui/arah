import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { Exit, Schema } from "effect";
import {
  assessCandidate,
  decide,
  isActive,
  pointInPolygon,
  routeTouches,
} from "../src/decide.js";
import { fitTrainRanking } from "../src/fit.js";
import { materialize } from "../src/observations.js";
import { parseRequestBody } from "../src/domain.js";
import type {
  CandidateRoute,
  CoverageEntry,
  EvidenceId,
  Observation,
  RouteId,
  RouteRequest,
} from "../src/domain.js";
import {
  DecisionOutput,
  EvidenceId as EvidenceIdSchema,
  RouteId as RouteIdSchema,
} from "../src/domain.js";
import { trainCandidates } from "../src/router.js";
import type { RegistryEntry } from "../src/places.js";

function routeId(raw: string): RouteId {
  return Schema.decodeSync(RouteIdSchema)(raw);
}

function evidenceId(raw: string): EvidenceId {
  return Schema.decodeSync(EvidenceIdSchema)(raw);
}

const NOW = Date.parse("2026-09-07T08:00:00+07:00");

const SQUARE: ReadonlyArray<{ lat: number; lon: number }> = [
  { lat: -6.3, lon: 106.7 },
  { lat: -6.3, lon: 106.8 },
  { lat: -6.2, lon: 106.8 },
  { lat: -6.2, lon: 106.7 },
];

const ALSUT_VENUE: RegistryEntry = {
  id: "alsut-loop",
  label: "Alsut loop",
  lat: -6.241,
  lon: 106.651,
  aliases: ["alsut", "alsut loop"],
  loops: [
    {
      id: "alsut-short",
      name: "Alsut short loop",
      points: [
        { lat: -6.241, lon: 106.651 },
        { lat: -6.235, lon: 106.658 },
        { lat: -6.241, lon: 106.651 },
      ],
      distanceKm: 11.5,
      climbM: 45,
      laneKind: "painted",
      lighting: "lit",
    },
  ],
};

function makeRoute(overrides: Partial<CandidateRoute>): CandidateRoute {
  return {
    id: routeId("binloop-short"),
    name: "Binloop short loop",
    kind: "loop",
    points: [
      { lat: -6.2842, lon: 106.7125 },
      { lat: -6.2795, lon: 106.7289 },
    ],
    distanceKm: 28.4,
    climbM: 120,
    laneKind: "painted",
    lighting: "lit",
    mapSnapshotId: "snap-1",
    routeSource: "lushu",
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation>): Observation {
  return {
    id: evidenceId("obs-1"),
    source: "flood",
    severity: "moderate",
    polygon: [...SQUARE],
    observedAt: new Date(NOW - 10 * 60_000).toISOString(),
    expiresAt: new Date(NOW + 50 * 60_000).toISOString(),
    coverage: "covered",
    note: "standing water",
    ...overrides,
  };
}

function makeCoverage(state: CoverageEntry["state"]): CoverageEntry {
  return { source: "flood", polygon: [...SQUARE], state };
}

const trainRequest: RouteRequest = {
  kind: "train",
  venue: "alsut loop",
  session: "long",
  minutes: 150,
  departAt: "2026-09-12T05:30:00+07:00",
  night: false,
};

describe("trainCandidates", () => {
  it("returns lushu loops for a registry venue", () => {
    const routes = trainCandidates(
      {
        label: ALSUT_VENUE.label,
        point: { lat: ALSUT_VENUE.lat, lon: ALSUT_VENUE.lon },
        source: "registry",
        venueId: ALSUT_VENUE.id,
      },
      [ALSUT_VENUE],
      "snap-1",
    );
    expect(routes.length).toBe(1);
    expect(routes[0]?.routeSource).toBe("lushu");
    expect(routes[0]?.kind).toBe("loop");
  });
});

describe("fitTrainRanking", () => {
  it("adds lap fit notes for training routes", () => {
    const routes = trainCandidates(
      {
        label: ALSUT_VENUE.label,
        point: { lat: ALSUT_VENUE.lat, lon: ALSUT_VENUE.lon },
        source: "registry",
        venueId: ALSUT_VENUE.id,
      },
      [ALSUT_VENUE],
      "snap-1",
    );
    const hazard = decide(
      {
        request: trainRequest,
        routes,
        observations: [],
        coverages: [makeCoverage("covered")],
        mapSnapshotId: "snap-1",
      },
      NOW,
    );
    const ranked = fitTrainRanking(hazard.ranked, routes, trainRequest);
    expect(ranked[0]?.suggestedLaps).toBeGreaterThan(0);
    expect(ranked[0]?.reasons.some((row) => row.startsWith("fit:"))).toBe(true);
  });
});

describe("pointInPolygon", () => {
  it("contains an interior point and rejects an exterior one", () => {
    expect(pointInPolygon({ lat: -6.25, lon: 106.75 }, SQUARE)).toBe(true);
    expect(pointInPolygon({ lat: -6.0, lon: 106.75 }, SQUARE)).toBe(false);
  });

  it("rejects degenerate polygons", () => {
    expect(pointInPolygon({ lat: -6.25, lon: 106.75 }, [])).toBe(false);
  });
});

describe("isActive", () => {
  it("holds inside the validity window only", () => {
    const observation = makeObservation({});
    expect(isActive(observation, NOW)).toBe(true);
    expect(isActive(observation, NOW + 60 * 60_000)).toBe(false);
    expect(isActive(observation, NOW - 60 * 60_000)).toBe(false);
  });
});

describe("assessCandidate", () => {
  it("allows a known route with no touching hazards", () => {
    const ranked = assessCandidate(
      {
        route: makeRoute({}),
        observations: [makeObservation({ polygon: [{ lat: 0, lon: 0 }] })],
        coverages: [makeCoverage("covered")],
        night: false,
      },
      NOW,
    );
    expect(ranked.verdict).toBe("allow");
    expect(ranked.evidenceIds).toEqual([]);
  });

  it("blocks on a touching severe observation", () => {
    const ranked = assessCandidate(
      {
        route: makeRoute({}),
        observations: [makeObservation({ severity: "severe" })],
        coverages: [makeCoverage("covered")],
        night: false,
      },
      NOW,
    );
    expect(ranked.verdict).toBe("block");
    expect(ranked.evidenceIds).toEqual(["obs-1"]);
  });

  it("expired observations never block", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (minutesPast) => {
        const ranked = assessCandidate(
          {
            route: makeRoute({}),
            observations: [
              makeObservation({
                severity: "severe",
                observedAt: new Date(
                  NOW - (minutesPast + 120) * 60_000,
                ).toISOString(),
                expiresAt: new Date(NOW - minutesPast * 60_000).toISOString(),
              }),
            ],
            coverages: [makeCoverage("covered")],
            night: false,
          },
          NOW,
        );
        expect(ranked.verdict).toBe("allow");
      }),
      { seed: 42 },
    );
  });

  it("missing coverage caps the verdict at withhold", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<CoverageEntry["state"]>(
          "not-covered",
          "unavailable",
          "stale",
        ),
        (state: CoverageEntry["state"]) => {
          const ranked = assessCandidate(
            {
              route: makeRoute({}),
              observations: [],
              coverages: [makeCoverage(state)],
              night: false,
            },
            NOW,
          );
          expect(ranked.verdict === "allow").toBe(false);
        },
      ),
      { seed: 7 },
    );
  });

  it("withholds night rides on unknown lighting", () => {
    const ranked = assessCandidate(
      {
        route: makeRoute({ lighting: "unknown", laneKind: "protected" }),
        observations: [],
        coverages: [],
        night: true,
      },
      NOW,
    );
    expect(ranked.verdict).toBe("withhold");
  });
});

describe("decide", () => {
  const routes = [
    makeRoute({ id: routeId("a-clear"), name: "a clear loop" }),
    makeRoute({ id: routeId("b-blocked"), name: "b blocked loop" }),
  ];

  it("ranks blocked routes below allowed ones", () => {
    const output = decide(
      {
        request: trainRequest,
        routes,
        observations: [
          makeObservation({ severity: "severe", id: evidenceId("obs-block") }),
        ],
        coverages: [],
        mapSnapshotId: "snap-1",
      },
      NOW,
    );
    expect(output.ranked.map((row) => row.routeId)).toEqual([
      "a-clear",
      "b-blocked",
    ]);
  });

  it("is deterministic", () => {
    const input = {
      request: trainRequest,
      routes,
      observations: [makeObservation({})],
      coverages: [makeCoverage("covered")],
      mapSnapshotId: "snap-1",
    };
    expect(decide(input, NOW)).toEqual(decide(input, NOW));
  });
});

describe("materialize", () => {
  it("keeps observed time before expiry for positive windows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 1, max: 600 }),
        (minutesAgo, validForMinutes) => {
          const state = materialize(
            [
              {
                id: evidenceId("obs-1"),
                source: "flood",
                severity: "moderate",
                polygon: [...SQUARE],
                minutesAgo,
                validForMinutes,
                coverage: "covered",
                note: "n",
              },
            ],
            [],
            "fixture",
            NOW,
          );
          const first = state.observations[0];
          expect(first !== undefined).toBe(true);
          if (first !== undefined) {
            expect(
              Date.parse(first.observedAt) < Date.parse(first.expiresAt),
            ).toBe(true);
          }
        },
      ),
      { seed: 11 },
    );
  });
});

describe("parseRequestBody", () => {
  it("parses train and go requests and rejects malformed bodies", () => {
    expect(parseRequestBody(JSON.stringify(trainRequest))).toEqual(
      trainRequest,
    );
    expect(
      parseRequestBody(
        JSON.stringify({
          kind: "go",
          origin: "home",
          destination: "oksigasi space",
          departAt: "2026-09-12T07:00:00+07:00",
          night: false,
        }),
      ),
    ).toEqual({
      kind: "go",
      origin: "home",
      destination: "oksigasi space",
      departAt: "2026-09-12T07:00:00+07:00",
      night: false,
    });
    expect(parseRequestBody("{nope")).toBe(null);
    expect(parseRequestBody(JSON.stringify({ kind: "fly" }))).toBe(null);
  });
});

describe("routeTouches", () => {
  it("detects interior route points", () => {
    expect(routeTouches(makeRoute({}), SQUARE)).toBe(true);
    expect(
      routeTouches(makeRoute({ points: [{ lat: 0, lon: 0 }] }), SQUARE),
    ).toBe(false);
  });
});

describe("DecisionOutput JSON", () => {
  it("decodes HttpApi payloads that encode missing optionals as null", () => {
    const wire = {
      intent: "train",
      ranked: [
        {
          routeId: "alsut-short",
          routeName: "Alsut short loop",
          verdict: "allow",
          reasons: ["ok"],
          evidenceIds: [],
          coverage: "covered",
        },
      ],
      routes: [
        {
          id: "go-direct",
          name: "direct",
          kind: "point-to-point",
          points: [{ lat: -6.28, lon: 106.71 }],
          distanceKm: 1,
          climbM: 0,
          laneKind: "unknown",
          lighting: "unknown",
          mapSnapshotId: "snap",
          routeSource: "osrm",
          venueId: null,
        },
      ],
      observations: [],
      mapSnapshotId: "snap",
      decidedAt: "2026-09-07T00:00:00.000Z",
      resolved: {
        origin: {
          label: "Home",
          point: { lat: -6.28, lon: 106.71 },
          source: "registry",
        },
        venue: {
          label: "Alsut loop",
          point: { lat: -6.24, lon: 106.65 },
          source: "registry",
          venueId: "alsut-loop",
        },
        destination: null,
      },
      routeSources: ["osrm"],
    };
    const exit = Schema.decodeUnknownExit(DecisionOutput)(wire);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.resolved.destination).toBeNull();
      expect(exit.value.routes[0]?.venueId).toBeNull();
    }
  });
});
