import { describe, expect, it } from "vitest";
import { nowcastObservation, NowcastUnavailable } from "../src/observations.js";

const payload = {
  hourly: {
    time: [
      "2026-09-12T05:00",
      "2026-09-12T06:00",
      "2026-09-12T07:00",
      "2026-09-12T08:00",
      "2026-09-12T09:00",
      "2026-09-12T10:00",
    ],
    precipitation_probability: [0, 20, 80, 60, 20, 10],
    weathercode: [0, 1, 61, 63, 3, 2],
    windspeed_10m: [10, 12, 16, 18, 12, 10],
  },
};

describe("nowcastObservation", () => {
  it("turns recorded Open-Meteo hourly frames into a nowcast observation", () => {
    const observation = nowcastObservation(
      { lat: -6.24, lon: 106.65 },
      payload,
      Date.parse("2026-09-12T04:00:00Z"),
    );
    expect(observation).not.toBeNull();
    expect(observation?.source).toBe("nowcast");
    expect(observation?.severity).toBe("severe");
    expect(observation?.coverage).toBe("covered");
    expect(observation?.polygon).toHaveLength(4);
  });

  it("reports moderate when showery rain is present without heavy rain", () => {
    const observation = nowcastObservation(
      { lat: -6.24, lon: 106.65 },
      {
        hourly: {
          time: ["2026-09-12T05:00", "2026-09-12T06:00"],
          precipitation_probability: [50, 40],
          weathercode: [61, 61],
          windspeed_10m: [18, 20],
        },
      },
      Date.parse("2026-09-12T04:00:00Z"),
    );
    expect(observation?.severity).toBe("moderate");
  });
});

describe("NowcastUnavailable", () => {
  it("is a tagged error", async () => {
    const error = new NowcastUnavailable({ detail: "no frames" });
    expect(error._tag).toBe("NowcastUnavailable");
  });
});