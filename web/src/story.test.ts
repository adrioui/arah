import { Command, given, message, model, story } from "foldkit/story";
import { expect, test } from "vitest";
import type { DecisionOutput } from "@arah/domain";

import {
  FetchDecision,
  FetchSuggestions,
  Message,
  init,
  update,
} from "./main.js";

const plannedDecision: DecisionOutput = {
  intent: "train",
  ranked: [],
  routes: [],
  observations: [],
  mapSnapshotId: "test-snapshot",
  decidedAt: "2026-09-09T04:00:00.000Z",
  resolved: {
    origin: {
      label: "Home",
      point: { lat: -6.2842, lon: 106.7125 },
      source: "registry",
    },
  },
  routeSources: ["lushu"],
};

test("submitting a train search enters loading", () => {
  const initial = {
    ...init().model,
    venueDraft: "alsut",
  };
  story(
    update,
    given(initial),
    message(Message.SubmittedSearch()),
    model((next) => {
      expect(next.decision._tag).toBe("Loading");
    }),
    Command.resolve(
      FetchDecision,
      Message.FailedPlan({ error: "cancelled in test" }),
    ),
  );
});

test("resubmitting with prior results enters refreshing", () => {
  const initial = {
    ...init().model,
    venueDraft: "alsut",
  };
  story(
    update,
    given(initial),
    message(
      Message.SucceededPlan({ decision: plannedDecision }),
    ),
    message(Message.SubmittedSearch()),
    model((next) => {
      expect(next.decision._tag).toBe("Refreshing");
    }),
    Command.resolve(
      FetchDecision,
      Message.FailedPlan({ error: "cancelled in test" }),
    ),
  );
});

test("submitting a train search without a venue shows validation failure", () => {
  story(
    update,
    given(init().model),
    message(Message.SubmittedSearch()),
    model((next) => {
      expect(next.decision._tag).toBe("Failure");
      if (next.decision._tag === "Failure") {
        expect(next.decision.error).toContain("venue");
      }
    }),
  );
});

test("go mode without a destination shows validation failure", () => {
  const initial = {
    ...init().model,
    mode: "train" as const,
  };
  story(
    update,
    given(initial),
    message(Message.SelectedMode({ mode: "go" })),
    message(Message.SubmittedSearch()),
    model((next) => {
      expect(next.mode).toBe("go");
      expect(next.decision._tag).toBe("Failure");
      if (next.decision._tag === "Failure") {
        expect(next.decision.error).toContain("destination");
      }
    }),
  );
});

test("selecting a venue suggestion fills the draft", () => {
  const initial = {
    ...init().model,
    suggestFor: "venue" as const,
  };
  story(
    update,
    given(initial),
    message(
      Message.SelectedSuggestion({ id: "alsut-loop", label: "Alsut loop" }),
    ),
    model((next) => {
      expect(next.venueDraft).toBe("Alsut loop");
      expect(next.suggestFor).toBe("none");
    }),
  );
});

test("toggling a layer hides and restores it", () => {
  story(
    update,
    given(init().model),
    message(Message.ToggledLayer({ layer: "flood" })),
    model((next) => {
      expect(next.hiddenLayers).toContain("flood");
    }),
    message(Message.ToggledLayer({ layer: "flood" })),
    model((next) => {
      expect(next.hiddenLayers).not.toContain("flood");
    }),
  );
});

test("typing a venue stores the draft", () => {
  story(
    update,
    given(init().model),
    message(Message.UpdatedVenue({ value: "binloop" })),
    model((next) => {
      expect(next.venueDraft).toBe("binloop");
      expect(next.suggestFor).toBe("venue");
    }),
    Command.resolve(
      FetchSuggestions,
      Message.SucceededSuggestions({ target: "venue", suggestions: [] }),
    ),
  );
});
