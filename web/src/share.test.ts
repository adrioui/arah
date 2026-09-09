import { expect, test } from "vitest";

import {
  buildShareLink,
  decodeShare,
  encodeShare,
  parseShareHash,
} from "./share.js";

const state = {
  origin: "home",
  destination: "oksigasi",
  routeId: "go-osrm-primary",
};

test("encodeShare round trips through decodeShare", () => {
  expect(decodeShare(encodeShare(state))).toEqual(state);
});

test("decodeShare keeps minimal state without a route", () => {
  expect(
    decodeShare(encodeShare({ origin: "home", destination: "kemang" })),
  ).toEqual({ origin: "home", destination: "kemang", routeId: undefined });
});

test("decodeShare rejects malformed payloads", () => {
  expect(decodeShare("!!!")).toBeNull();
  expect(decodeShare("")).toBeNull();
});

test("buildShareLink plus parseShareHash round trip", () => {
  const link = buildShareLink("https://example.test", state);
  const hash = link.slice(link.indexOf("#"));
  expect(parseShareHash(hash)).toEqual(state);
});

test("parseShareHash rejects foreign hashes", () => {
  expect(parseShareHash("")).toBeNull();
  expect(parseShareHash("#other=1")).toBeNull();
});
