import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

type LngLatTuple = [number, number];
type LineGeometry = { readonly type: "LineString"; readonly coordinates: Array<LngLatTuple> };
type PolygonGeometry = { readonly type: "Polygon"; readonly coordinates: Array<Array<LngLatTuple>> };
type MapFeature = {
  readonly type: "Feature";
  readonly properties: Record<string, string>;
  readonly geometry: LineGeometry | PolygonGeometry;
};
type FeatureCollection = {
  readonly type: "FeatureCollection";
  readonly features: Array<MapFeature>;
};

export interface MapRoute {
  readonly id: string;
  readonly name: string;
  readonly kind: "loop" | "point-to-point";
  readonly points: ReadonlyArray<{ readonly lat: number; readonly lon: number }>;
  readonly routeSource: string;
}

export interface MapObservation {
  readonly id: string;
  readonly source: string;
  readonly severity: "severe" | "moderate" | "info";
  readonly polygon: ReadonlyArray<{ readonly lat: number; readonly lon: number }>;
  readonly note: string;
}

const STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

function coordinates(
  points: ReadonlyArray<{ readonly lat: number; readonly lon: number }>,
): Array<[number, number]> {
  return points.map((point) => [point.lon, point.lat]);
}

function routeGeometry(route: MapRoute): LineGeometry {
  const coords = coordinates(route.points);
  if (route.kind === "loop" && coords.length > 1 && coords[0] !== undefined) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (
      first !== undefined &&
      last !== undefined &&
      (first[0] !== last[0] || first[1] !== last[1])
    ) {
      coords.push(first);
    }
  }
  return { type: "LineString", coordinates: coords };
}

function polygonGeometry(
  polygon: ReadonlyArray<{ readonly lat: number; readonly lon: number }>,
): PolygonGeometry | null {
  if (polygon.length < 3) {
    return null;
  }
  return { type: "Polygon", coordinates: [coordinates(polygon)] };
}

function routesFeatureCollection(
  routes: ReadonlyArray<MapRoute>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: routes.flatMap((route) =>
      route.points.length < 2
        ? []
        : [
            {
              type: "Feature",
              properties: {
                id: route.id,
                name: route.name,
                routeSource: route.routeSource,
              },
              geometry: routeGeometry(route),
            },
          ],
    ),
  };
}

function observationsFeatureCollection(
  observations: ReadonlyArray<MapObservation>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: observations.flatMap((observation) => {
      const geometry = polygonGeometry(observation.polygon);
      return geometry === null
        ? []
        : [
            {
              type: "Feature",
              properties: {
                id: observation.id,
                source: observation.source,
                severity: observation.severity,
                note: observation.note,
              },
              geometry,
            },
          ];
    }),
  };
}

function parseRoutes(value: string): ReadonlyArray<MapRoute> {
  if (value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) === false) {
      return [];
    }
    // SAFETY: JSON.parse returns unknown; the array check is the boundary contract.
    return parsed as ReadonlyArray<MapRoute>;
  } catch {
    return [];
  }
}

function parseObservations(value: string): ReadonlyArray<MapObservation> {
  if (value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) === false) {
      return [];
    }
    // SAFETY: JSON.parse returns unknown; the array check is the boundary contract.
    return parsed as ReadonlyArray<MapObservation>;
  } catch {
    return [];
  }
}

class ArahMapElement extends HTMLElement {
  #map: maplibregl.Map | null = null;
  #routes: ReadonlyArray<MapRoute> = [];
  #observations: ReadonlyArray<MapObservation> = [];

  connectedCallback(): void {
    if (this.#map !== null) {
      return;
    }
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
    this.#map = new maplibregl.Map({
      container: this,
      style: STYLE_URL,
      center: [106.79, -6.27],
      zoom: 11,
    });
    this.#map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
    );
    this.#map.on("load", () => this.render());
  }

  disconnectedCallback(): void {
    this.#map?.remove();
    this.#map = null;
  }

  set routes(value: string) {
    this.#routes = parseRoutes(value);
    this.render();
  }

  get routes(): string {
    return JSON.stringify(this.#routes);
  }

  set observations(value: string) {
    this.#observations = parseObservations(value);
    this.render();
  }

  get observations(): string {
    return JSON.stringify(this.#observations);
  }

  private render(): void {
    if (this.#map === null || this.#map.loaded() === false) {
      return;
    }
    this.renderRoutes(this.#routes);
    this.renderObservations(this.#observations);
    this.fitBounds(this.#routes);
  }

  private renderRoutes(routes: ReadonlyArray<MapRoute>): void {
    const data = routesFeatureCollection(routes);
    const source = this.#map!.getSource<maplibregl.GeoJSONSource>("routes");
    if (source !== undefined) {
      source.setData(data);
      return;
    }
    this.#map!.addSource("routes", { type: "geojson", data });
    this.#map!.addLayer({
      id: "route-casing",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0f766e", "line-width": 8, "line-opacity": 0.35 },
    });
    this.#map!.addLayer({
      id: "route-line",
      type: "line",
      source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0d9488", "line-width": 5 },
    });
  }

  private renderObservations(observations: ReadonlyArray<MapObservation>): void {
    const data = observationsFeatureCollection(observations);
    const source = this.#map!.getSource<maplibregl.GeoJSONSource>("observations");
    if (source !== undefined) {
      source.setData(data);
      return;
    }
    this.#map!.addSource("observations", { type: "geojson", data });
    this.#map!.addLayer({
      id: "observation-fill",
      type: "fill",
      source: "observations",
      layout: {},
      paint: {
        "fill-color": [
          "match",
          ["get", "severity"],
          "severe",
          "#e11d48",
          "moderate",
          "#f59e0b",
          "#0ea5e9",
        ],
        "fill-opacity": 0.35,
      },
    });
    this.#map!.addLayer({
      id: "observation-outline",
      type: "line",
      source: "observations",
      layout: {},
      paint: {
        "line-color": [
          "match",
          ["get", "severity"],
          "severe",
          "#e11d48",
          "moderate",
          "#f59e0b",
          "#0ea5e9",
        ],
        "line-width": 2,
      },
    });
  }

  private fitBounds(routes: ReadonlyArray<MapRoute>): void {
    const points = routes.flatMap((route) => [...route.points]);
    if (points.length === 0) {
      return;
    }
    const lats = points.map((point) => point.lat);
    const lons = points.map((point) => point.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    this.#map!.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 60, maxZoom: 15, duration: 500 },
    );
  }
}

export function registerArahMap(): void {
  if (customElements.get("arah-map") === undefined) {
    customElements.define("arah-map", ArahMapElement);
  }
}

export function routesAttribute(routes: ReadonlyArray<MapRoute>): string {
  return JSON.stringify(routes);
}

export function observationsAttribute(
  observations: ReadonlyArray<MapObservation>,
): string {
  return JSON.stringify(observations);
}