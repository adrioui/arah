import { expect, test } from "vitest";

import { gpxDownload, routeToGpx } from "./gpx.js";

const sample = {
  id: "pondok-aren-oksigasi",
  name: "Home to Oksigasi <Space>",
  points: [
    { lat: -6.2842, lon: 106.7125 },
    { lat: -6.26, lon: 106.7 },
  ],
};

test("routeToGpx emits one trkpt per point", () => {
  const gpx = routeToGpx(sample);
  expect(gpx).toContain('version="1.1"');
  expect(gpx.match(/<trkpt/g)?.length).toBe(2);
  expect(gpx).toContain('lat="-6.284200" lon="106.712500"');
});

test("routeToGpx escapes xml in names", () => {
  const gpx = routeToGpx(sample);
  expect(gpx).toContain("Oksigasi &lt;Space&gt;");
  expect(gpx).not.toContain("<Space>");
});

test("gpxDownload names the file after the route", () => {
  const download = gpxDownload(sample);
  expect(download.filename).toBe("pondok-aren-oksigasi.gpx");
  expect(download.href.startsWith("data:application/gpx+xml")).toBe(true);
  expect(decodeURIComponent(download.href)).toContain("<trkseg>");
});
