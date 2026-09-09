import { Exit, Schema } from "effect";

export interface ShareState {
  readonly origin: string;
  readonly destination: string;
  readonly routeId?: string | undefined;
}

const ShareStateSchema = Schema.Struct({
  origin: Schema.String,
  destination: Schema.String,
  routeId: Schema.optional(Schema.String),
});

function toBase64Url(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

/** Encode plan state into a compact hash payload. Pure and total. */
export function encodeShare(state: ShareState): string {
  return toBase64Url(JSON.stringify(state));
}

/** Decode a hash payload back into plan state. Null when malformed. */
export function decodeShare(encoded: string): ShareState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }
  const exit = Schema.decodeUnknownExit(ShareStateSchema)(parsed);
  if (Exit.isSuccess(exit) === false) {
    return null;
  }
  return {
    origin: exit.value.origin,
    destination: exit.value.destination,
    routeId: exit.value.routeId,
  };
}

/** Full shareable link for the current origin. */
export function buildShareLink(
  originUrl: string,
  state: ShareState,
): string {
  return `${originUrl}#plan=${encodeShare(state)}`;
}

/** Parse a location hash into plan state. Null when absent or malformed. */
export function parseShareHash(hash: string): ShareState | null {
  const match = hash.match(/^#plan=(.+)$/);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return decodeShare(match[1]);
}
