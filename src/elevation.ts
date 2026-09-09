import { inflateSync } from "node:zlib";
import type { GeoPoint } from "./domain.js";

const TILE_ZOOM = 12;
const TILE_URL = (z: number, x: number, y: number): string =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** Convert one pixel to meters. Terrarium encoding, always total. */
export function terrariumToMeters(red: number, green: number, blue: number): number {
  return red * 256 + green + blue / 256 - 32768;
}

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom,
  );
}

interface TileImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Minimal PNG decoder for 8-bit RGB/RGBA non-interlaced tiles. */
export function decodePngRgba(bytes: Uint8Array): TileImage | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i = i + 1) {
    if (bytes[i] !== signature[i]) {
      return null;
    }
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Array<Uint8Array> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type =
      String.fromCharCode(bytes[offset + 4] ?? 0) +
      String.fromCharCode(bytes[offset + 5] ?? 0) +
      String.fromCharCode(bytes[offset + 6] ?? 0) +
      String.fromCharCode(bytes[offset + 7] ?? 0);
    const chunk = bytes.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = bytes[offset + 16] ?? 0;
      colorType = bytes[offset + 17] ?? 0;
    } else if (type === "IDAT") {
      idat.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset = offset + 8 + length + 4;
  }
  if (width === 0 || height === 0 || bitDepth !== 8) {
    return null;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) {
    return null;
  }
  const joined = Buffer.concat(idat.map((part) => Buffer.from(part)));
  let raw: Uint8Array;
  try {
    raw = inflateSync(joined);
  } catch {
    return null;
  }
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  let position = 0;
  for (let y = 0; y < height; y = y + 1) {
    const filter = raw[position] ?? 0;
    position = position + 1;
    for (let x = 0; x < stride; x = x + 1) {
      const current = raw[position] ?? 0;
      position = position + 1;
      const pixel = Math.floor(x / channels);
      const channel = x % channels;
      const left = x >= channels ? (data[(y * width + pixel - 1) * 4 + channel] ?? 0) : 0;
      const above = y > 0 ? (data[((y - 1) * width + pixel) * 4 + channel] ?? 0) : 0;
      const upperLeft = x >= channels && y > 0
        ? (data[((y - 1) * width + pixel - 1) * 4 + channel] ?? 0)
        : 0;
      data[(y * width + pixel) * 4 + channel] = unfilter(
        filter,
        current,
        left,
        above,
        upperLeft,
      );
    }
  }
  return { width, height, data };
}

function unfilter(
  filter: number,
  current: number,
  left: number,
  above: number,
  upperLeft: number,
): number {
  if (filter === 1) {
    return (current + left) % 256;
  }
  if (filter === 2) {
    return (current + above) % 256;
  }
  if (filter === 3) {
    return (current + Math.floor((left + above) / 2)) % 256;
  }
  if (filter === 4) {
    const p = left + above - upperLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - above);
    const pc = Math.abs(p - upperLeft);
    let predictor = upperLeft;
    if (pa <= pb && pa <= pc) {
      predictor = left;
    } else if (pb <= pc) {
      predictor = above;
    }
    return (current + predictor) % 256;
  }
  return current;
}

/** Height in meters for one point, or null when tiles are unreachable. */
export async function sampleElevation(point: GeoPoint): Promise<number | null> {
  const x = lonToTileX(point.lon, TILE_ZOOM);
  const y = latToTileY(point.lat, TILE_ZOOM);
  try {
    const response = await fetch(TILE_URL(TILE_ZOOM, x, y), {
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok === false) {
      return null;
    }
    const image = decodePngRgba(
      new Uint8Array(await response.arrayBuffer()),
    );
    if (image === null) {
      return null;
    }
    const n = 2 ** TILE_ZOOM;
    const px = Math.min(
      image.width - 1,
      Math.max(
        0,
        Math.floor((((point.lon + 180) / 360) * n - x) * image.width),
      ),
    );
    const latRad = (point.lat * Math.PI) / 180;
    const worldY =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n;
    const py = Math.min(
      image.height - 1,
      Math.max(0, Math.floor((worldY - y) * image.height)),
    );
    const base = (py * image.width + px) * 4;
    return terrariumToMeters(
      image.data[base] ?? 0,
      image.data[base + 1] ?? 0,
      image.data[base + 2] ?? 0,
    );
  } catch {
    return null;
  }
}

const elevationCache = new Map<string, ReadonlyArray<number>>();

/** Sample every Nth point of a route. Cached per route id. */
export async function sampleRouteElevation(
  routeId: string,
  points: ReadonlyArray<GeoPoint>,
): Promise<ReadonlyArray<number>> {
  const cached = elevationCache.get(routeId);
  if (cached !== undefined) {
    return cached;
  }
  const step = Math.max(1, Math.floor(points.length / 10));
  const picked = points.filter((_, index) => index % step === 0);
  const samples: Array<number> = [];
  for (const point of picked) {
    const height = await sampleElevation(point);
    if (height !== null) {
      samples.push(Math.round(height));
    }
  }
  elevationCache.set(routeId, samples);
  return samples;
}
