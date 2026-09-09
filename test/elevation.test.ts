import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";

import { decodePngRgba, terrariumToMeters } from "../src/elevation.js";

function craftPng(pixels: Array<[number, number, number]>): Uint8Array {
  const width = pixels.length;
  const raw = Buffer.alloc(1 + width * 3);
  raw[0] = 0;
  pixels.forEach(([r, g, b], index) => {
    raw[1 + index * 3] = r;
    raw[1 + index * 3 + 1] = g;
    raw[1 + index * 3 + 2] = b;
  });
  const idat = deflateSync(raw);
  const chunks: Array<Buffer> = [];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const push = (type: string, data: Buffer): void => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4);
    chunks.push(header, data, Buffer.alloc(4));
  };
  push("IHDR", ihdr);
  push("IDAT", idat);
  push("IEND", Buffer.alloc(0));
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]),
  );
}

describe("terrariumToMeters", () => {
  it("decodes sea level and known heights", () => {
    expect(terrariumToMeters(128, 0, 0)).toBe(0);
    expect(terrariumToMeters(128, 1, 0)).toBe(1);
    expect(terrariumToMeters(0, 0, 0)).toBe(-32768);
  });
});

describe("decodePngRgba", () => {
  it("decodes a crafted rgb row", () => {
    const image = decodePngRgba(
      craftPng([
        [128, 0, 0],
        [128, 64, 0],
      ]),
    );
    expect(image?.width).toBe(2);
    expect(image?.height).toBe(1);
    expect(image?.data[0]).toBe(128);
    expect(image?.data[4]).toBe(128);
    expect(image?.data[5]).toBe(64);
  });

  it("rejects non png bytes", () => {
    expect(decodePngRgba(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
