function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface GpxRoute {
  readonly id: string;
  readonly name: string;
  readonly points: ReadonlyArray<{
    readonly lat: number;
    readonly lon: number;
  }>;
}

/** Build a GPX 1.1 track from route points. Pure and total. */
export function routeToGpx(route: GpxRoute): string {
  const segments = route.points
    .map(
      (point) =>
        `      <trkpt lat="${point.lat.toFixed(6)}" lon="${point.lon.toFixed(6)}" />`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="arah" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata>\n    <name>${escapeXml(route.name)}</name>\n  </metadata>\n  <trk>\n    <name>${escapeXml(route.name)}</name>\n    <trkseg>\n${segments}\n    </trkseg>\n  </trk>\n</gpx>\n`;
}

/** Download-ready data URL plus filename for one route. */
export function gpxDownload(route: GpxRoute): {
  href: string;
  filename: string;
} {
  return {
    href: `data:application/gpx+xml;charset=utf-8,${encodeURIComponent(routeToGpx(route))}`,
    filename: `${route.id}.gpx`,
  };
}
