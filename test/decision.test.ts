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
import { rankGoRoutes } from "../src/fit.js";
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

const goRequest: RouteRequest = {
  kind: "go",
  origin: "home",
  destination: "oksigasi space",
  departAt: "2026-09-12T05:30:00+07:00",
  night: false,
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


describe("rankGoRoutes", () => {
  it("prefers lit protected routes when preferences ask", () => {
    const routes = [
      makeRoute({
        id: routeId("dark-shared"),
        name: "dark shared",
        lighting: "unlit",
        laneKind: "shared",
        distanceKm: 5,
        climbM: 10,
      }),
      makeRoute({
        id: routeId("lit-protected"),
        name: "lit protected",
        lighting: "lit",
        laneKind: "protected",
        distanceKm: 6,
        climbM: 10,
      }),
    ];
    const hazard = decide(
      {
        request: goRequest,
        routes,
        observations: [],
        coverages: [makeCoverage("covered")],
        mapSnapshotId: "snap-1",
      },
      NOW,
    );
    const plain = rankGoRoutes(hazard.ranked, routes);
    expect(plain[0]?.routeId).toBe("dark-shared");
    const ranked = rankGoRoutes(hazard.ranked, routes, {
      hills: 1,
      avoidUnlit: true,
      preferProtected: true,
      night: true,
    });
    expect(ranked[0]?.routeId).toBe("lit-protected");
    expect(
      ranked.find((row) => row.routeId === "dark-shared")?.reasons.some((row) =>
        row.startsWith("pref:"),
      ),
    ).toBe(true);
  });

  it("adds reach notes and sorts by verdict then time", () => {
    const routes = [
      makeRoute({ id: routeId("a-clear"), name: "a clear route" }),
      makeRoute({ id: routeId("b-blocked"), name: "b blocked route" }),
    ];
    const hazard = decide(
      {
        request: goRequest,
        routes,
        observations: [
          makeObservation({ severity: "severe", id: evidenceId("obs-block") }),
        ],
        coverages: [makeCoverage("covered")],
        mapSnapshotId: "snap-1",
      },
      NOW,
    );
    const ranked = rankGoRoutes(hazard.ranked, routes);
    expect(ranked.map((row) => row.routeId)).toEqual([
      "a-clear",
      "b-blocked",
    ]);
    expect(ranked[0]?.reasons.some((row) => row.startsWith("reach:"))).toBe(
      true,
    );
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

  it("blocks when a segment crosses a polygon while both endpoints are outside", () => {
    const ranked = assessCandidate(
      {
        route: makeRoute({
          points: [
            { lat: -6.25, lon: 106.6 },
            { lat: -6.25, lon: 106.9 },
          ],
        }),
        observations: [makeObservation({ severity: "severe" })],
        coverages: [makeCoverage("covered")],
        night: false,
      },
      NOW,
    );
    expect(ranked.verdict).toBe("block");
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

  it("withholds when no coverage entry intersects the route", () => {
    const ranked = assessCandidate(
      {
        route: makeRoute({}),
        observations: [],
        coverages: [],
        night: false,
      },
      NOW,
    );
    expect(ranked.verdict).toBe("withhold");
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
        request: goRequest,
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
      request: goRequest,
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
  it("parses go requests and rejects malformed bodies", () => {
    expect(parseRequestBody(JSON.stringify(goRequest))).toEqual(goRequest);
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

  it("rejects invalid coordinates", () => {
    for (const origin of [
      { lat: 91, lon: 106.0 },
      { lat: 0, lon: 181 },
    ]) {
      expect(
        parseRequestBody(JSON.stringify({ ...goRequest, origin })),
      ).toBe(null);
    }
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
  it("decodes HttpApi payloads for go decisions", () => {
    const wire = {
      intent: "go",
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
          points: [
            { lat: -6.28, lon: 106.71 },
            { lat: -6.282, lon: 106.716 },
          ],
          distanceKm: 1,
          climbM: 0,
          laneKind: "unknown",
          lighting: "unknown",
          mapSnapshotId: "snap",
          routeSource: "gpx",
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
        destination: {
          label: "Oksigasi Space",
          point: { lat: -6.26, lon: 106.7 },
          source: "registry",
        },
      },
      routeSources: ["gpx"],
    };
    const exit = Schema.decodeUnknownExit(DecisionOutput)(wire);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.resolved.destination.label).toBe("Oksigasi Space");
      expect(exit.value.intent).toBe("go");
    }
  });
});
