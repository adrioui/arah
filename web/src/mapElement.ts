import { Exit, Schema } from "effect";
import { GeoPoint } from "@arah/domain";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

type LngLatTuple = [number, number];
type LineGeometry = {
  readonly type: "LineString";
  readonly coordinates: Array<LngLatTuple>;
};
type PolygonGeometry = {
  readonly type: "Polygon";
  readonly coordinates: Array<Array<LngLatTuple>>;
};
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
  readonly points: ReadonlyArray<{
    readonly lat: number;
    readonly lon: number;
  }>;
  readonly routeSource: string;
}

export interface MapObservation {
  readonly id: string;
  readonly source: string;
  readonly severity: "severe" | "moderate" | "info";
  readonly polygon: ReadonlyArray<{
    readonly lat: number;
    readonly lon: number;
  }>;
  readonly note: string;
  readonly observedAt?: string | undefined;
}

export interface MapMarker {
  readonly id: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly kind: "origin" | "destination";
}

const STYLE_URLS = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
} as const;

export type BasemapKind = keyof typeof STYLE_URLS;

export type OfflineKind = "online" | "offline";

const OFFLINE_STYLE = {
  version: 8 as const,
  name: "arah-offline",
  sources: {},
  layers: [
    {
      id: "background",
      type: "background" as const,
      paint: { "background-color": "#e2e8f0" },
    },
  ],
};

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

const MapRouteSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["loop", "point-to-point"]),
  points: Schema.Array(GeoPoint).pipe(Schema.check(Schema.isMinLength(2))),
  routeSource: Schema.String,
});

const MapObservationSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  severity: Schema.Literals(["severe", "moderate", "info"]),
  polygon: Schema.Array(GeoPoint).pipe(Schema.check(Schema.isMinLength(3))),
  note: Schema.String,
  observedAt: Schema.optional(Schema.String),
});

const MapMarkerSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  lat: Schema.Number,
  lon: Schema.Number,
  kind: Schema.Literals(["origin", "destination"]),
});

function parseRoutes(value: string): ReadonlyArray<MapRoute> {
  if (value.length === 0) {
    return [];
  }
  try {
    const exit = Schema.decodeUnknownExit(Schema.Array(MapRouteSchema))(
      JSON.parse(value),
    );
    return Exit.isSuccess(exit) ? exit.value : [];
  } catch {
    return [];
  }
}

function parseObservations(value: string): ReadonlyArray<MapObservation> {
  if (value.length === 0) {
    return [];
  }
  try {
    const exit = Schema.decodeUnknownExit(Schema.Array(MapObservationSchema))(
      JSON.parse(value),
    );
    return Exit.isSuccess(exit) ? exit.value : [];
  } catch {
    return [];
  }
}

function parseMarkers(value: string): ReadonlyArray<MapMarker> {
  if (value.length === 0) {
    return [];
  }
  try {
    const exit = Schema.decodeUnknownExit(Schema.Array(MapMarkerSchema))(
      JSON.parse(value),
    );
    return Exit.isSuccess(exit) ? exit.value : [];
  } catch {
    return [];
  }
}

const HOME_CENTER: [number, number] = [106.79, -6.27];
const HOME_ZOOM = 11;

const MapIsochroneSchema = Schema.Array(GeoPoint).pipe(
  Schema.check(Schema.isMinLength(3)),
);

function parseIsochrone(
  value: string,
): ReadonlyArray<{ readonly lat: number; readonly lon: number }> {
  if (value.length === 0) {
    return [];
  }
  try {
    const exit = Schema.decodeUnknownExit(MapIsochroneSchema)(
      JSON.parse(value),
    );
    return Exit.isSuccess(exit) ? exit.value : [];
  } catch {
    return [];
  }
}

class ArahMapElement extends HTMLElement {
  #map: maplibregl.Map | null = null;
  #routes: ReadonlyArray<MapRoute> = [];
  #observations: ReadonlyArray<MapObservation> = [];
  #markers: ReadonlyArray<MapMarker> = [];
  #isochrone: ReadonlyArray<{ readonly lat: number; readonly lon: number }> =
    [];
  #selected: string = "";
  #basemap: BasemapKind = "light";
  #offline: OfflineKind = "online";
  #focus: string = "";
  #popup: maplibregl.Popup | null = null;

  connectedCallback(): void {
    if (this.#map !== null) {
      return;
    }
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
    this.#map = new maplibregl.Map({
      container: this,
      style: STYLE_URLS[this.#basemap],
      center: HOME_CENTER,
      zoom: HOME_ZOOM,
    });
    this.#map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
    );
    this.#map.on("style.load", () => this.render());
    this.#map.on("click", "observation-fill", (event) =>
      this.showObservationPopup(event),
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

  set selected(value: string) {
    this.#selected = value;
    this.render();
  }

  get selected(): string {
    return this.#selected;
  }

  set basemap(value: string) {
    const next: BasemapKind = value === "dark" ? "dark" : "light";
    if (next === this.#basemap) {
      return;
    }
    this.#basemap = next;
    if (this.#map !== null) {
      this.#map.setStyle(STYLE_URLS[next]);
    }
  }

  get basemap(): string {
    return this.#basemap;
  }

  set offline(value: string) {
    const next: OfflineKind = value === "offline" ? "offline" : "online";
    if (next === this.#offline) {
      return;
    }
    this.#offline = next;
    if (this.#map !== null) {
      this.#map.setStyle(
        next === "offline" ? OFFLINE_STYLE : STYLE_URLS[this.#basemap],
      );
    }
  }

  get offline(): string {
    return this.#offline;
  }

  set markers(value: string) {
    this.#markers = parseMarkers(value);
    this.render();
  }

  get markers(): string {
    return JSON.stringify(this.#markers);
  }

  set isochrone(value: string) {
    this.#isochrone = parseIsochrone(value);
    this.render();
  }

  get isochrone(): string {
    return JSON.stringify(this.#isochrone);
  }

  set mapFocus(value: string) {
    if (value === this.#focus) {
      return;
    }
    this.#focus = value;
    this.applyFocus();
  }

  get mapFocus(): string {
    return this.#focus;
  }

  private render(): void {
    if (this.#map === null || this.#map.loaded() === false) {
      return;
    }
    this.renderRoutes(this.#routes, this.#selected);
    this.renderObservations(this.#observations);
    this.renderMarkers(this.#markers);
    this.renderIsochrone(this.#isochrone);
    this.fitBounds(this.#routes);
  }

  private renderRoutes(
    routes: ReadonlyArray<MapRoute>,
    selectedId: string,
  ): void {
    const data = routesFeatureCollection(routes);
    const source = this.#map!.getSource<maplibregl.GeoJSONSource>("routes");
    if (source !== undefined) {
      source.setData(data);
    } else {
      this.#map!.addSource("routes", { type: "geojson", data });
      this.#map!.addLayer({
        id: "route-casing",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0f766e",
          "line-width": 6,
          "line-opacity": 0.3,
        },
      });
      this.#map!.addLayer({
        id: "route-line",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0d9488", "line-width": 4 },
      });
    }
    this.renderSelectedRoute(routes, selectedId);
  }

  private renderSelectedRoute(
    routes: ReadonlyArray<MapRoute>,
    selectedId: string,
  ): void {
    const selected = routes.find((route) => route.id === selectedId);
    if (selected === undefined) {
      if (this.#map!.getLayer("route-selected-line") !== undefined) {
        this.#map!.removeLayer("route-selected-line");
      }
      if (this.#map!.getLayer("route-selected-casing") !== undefined) {
        this.#map!.removeLayer("route-selected-casing");
      }
      if (this.#map!.getSource("route-selected") !== undefined) {
        this.#map!.removeSource("route-selected");
      }
      return;
    }
    const data = routesFeatureCollection([selected]);
    const source =
      this.#map!.getSource<maplibregl.GeoJSONSource>("route-selected");
    if (source !== undefined) {
      source.setData(data);
      return;
    }
    this.#map!.addSource("route-selected", { type: "geojson", data });
    this.#map!.addLayer({
      id: "route-selected-casing",
      type: "line",
      source: "route-selected",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ea580c", "line-width": 10, "line-opacity": 0.4 },
    });
    this.#map!.addLayer({
      id: "route-selected-line",
      type: "line",
      source: "route-selected",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ea580c", "line-width": 6 },
    });
  }

  private renderObservations(
    observations: ReadonlyArray<MapObservation>,
  ): void {
    const data = observationsFeatureCollection(observations);
    const source =
      this.#map!.getSource<maplibregl.GeoJSONSource>("observations");
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

  private renderMarkers(markers: ReadonlyArray<MapMarker>): void {
    const data = {
      type: "FeatureCollection" as const,
      features: markers.map((marker) => ({
        type: "Feature" as const,
        properties: {
          id: marker.id,
          label: marker.label,
          kind: marker.kind,
        },
        geometry: {
          type: "Point" as const,
          // SAFETY: marker lat/lon decode as finite numbers from the schema.
          coordinates: [marker.lon, marker.lat] as [number, number],
        },
      })),
    };
    const source =
      this.#map!.getSource<maplibregl.GeoJSONSource>("markers");
    if (source !== undefined) {
      // SAFETY: point features match the GeoJSON the markers source was built with.
      source.setData(data as never);
      return;
    }
    this.#map!.addSource("markers", { type: "geojson", data });
    this.#map!.addLayer({
      id: "marker-circle",
      type: "circle",
      source: "markers",
      paint: {
        "circle-color": [
          "match",
          ["get", "kind"],
          "origin",
          "#059669",
          "#2563eb",
        ],
        "circle-radius": 8,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    this.#map!.addLayer({
      id: "marker-label",
      type: "symbol",
      source: "markers",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-offset": [0, 1.4],
      },
      paint: {
        "text-color": "#0f172a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.5,
      },
    });
  }

  private showObservationPopup(
    event: maplibregl.MapLayerMouseEvent & {
      features?: Array<maplibregl.MapGeoJSONFeature>;
    },
  ): void {
    const feature = event.features?.[0];
    if (feature === undefined) {
      return;
    }
    // SAFETY: GeoJSON feature properties decode as string maps from our source.
    const props = feature.properties as Record<string, string>;
    const observed = props["observedAt"];
    this.#popup?.remove();
    this.#popup = new maplibregl.Popup({ closeButton: true })
      .setLngLat(event.lngLat)
      .setHTML(
        `<strong>${props["source"] ?? "observation"} · ${props["severity"] ?? "info"}</strong><br>${props["note"] ?? ""}${observed !== undefined ? `<br><small>${observed}</small>` : ""}`,
      )
      .addTo(this.#map!);
  }

  private applyFocus(): void {
    if (this.#map === null || this.#map.loaded() === false) {
      return;
    }
    const [target] = this.#focus.split(":");
    if (target === undefined || target === "" || target === "home") {
      this.#map.easeTo({ center: HOME_CENTER, zoom: HOME_ZOOM });
      return;
    }
    if (target === "routes") {
      this.fitBounds(this.#routes);
      return;
    }
    const layerSources = {
      flood: ["flood"],
      closure: ["closure"],
      weather: ["bmkg", "nowcast", "air"],
    } as const;
    // SAFETY: target comes from the focus nonce the app sets to a known layer.
    const sources: ReadonlyArray<string> | undefined =
      layerSources[target as keyof typeof layerSources];
    if (sources === undefined) {
      return;
    }
    const points = this.#observations
      .filter((observation) => sources.includes(observation.source))
      .flatMap((observation) => [...observation.polygon]);
    if (points.length === 0) {
      return;
    }
    const lats = points.map((point) => point.lat);
    const lons = points.map((point) => point.lon);
    this.#map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 60, maxZoom: 14, duration: 500 },
    );
  }

  private renderIsochrone(
    ring: ReadonlyArray<{ readonly lat: number; readonly lon: number }>,
  ): void {
    const geometry = polygonGeometry(ring);
    const data: FeatureCollection = {
      type: "FeatureCollection",
      features:
        geometry === null
          ? []
          : [
              {
                type: "Feature",
                properties: { id: "reach", source: "reach", severity: "info", note: "reach" },
                geometry,
              },
            ],
    };
    const source =
      this.#map!.getSource<maplibregl.GeoJSONSource>("isochrone");
    if (source !== undefined) {
      source.setData(data);
      return;
    }
    this.#map!.addSource("isochrone", { type: "geojson", data });
    this.#map!.addLayer({
      id: "isochrone-fill",
      type: "fill",
      source: "isochrone",
      layout: {},
      paint: {
        "fill-color": "#10b981",
        "fill-opacity": 0.12,
      },
    });
    this.#map!.addLayer({
      id: "isochrone-outline",
      type: "line",
      source: "isochrone",
      layout: {},
      paint: {
        "line-color": "#10b981",
        "line-width": 2,
        "line-dasharray": [2, 2],
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
