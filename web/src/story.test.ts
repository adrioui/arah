import { Command, given, message, model, story } from "foldkit/story";
import { expect, test } from "vitest";
import type { DecisionOutput } from "@arah/domain";

import {
  FetchDecision,
  FetchFeedback,
  FetchSuggestions,
  Message,
  init,
  update,
} from "./main.js";

const plannedDecision: DecisionOutput = {
  intent: "go",
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
    destination: {
      label: "Oksigasi Space",
      point: { lat: -6.26, lon: 106.7 },
      source: "registry",
    },
  },
  routeSources: ["osrm"],
};

test("submitting a go search enters loading", () => {
  const initial = {
    ...init().model,
    destinationDraft: "oksigasi",
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
    destinationDraft: "oksigasi",
  };
  story(
    update,
    given(initial),
    message(Message.SucceededPlan({ decision: plannedDecision })),
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

test("submitting a go search without a destination shows validation failure", () => {
  story(
    update,
    given(init().model),
    message(Message.SubmittedSearch()),
    model((next) => {
      expect(next.decision._tag).toBe("Failure");
      if (next.decision._tag === "Failure") {
        expect(next.decision.error).toContain("destination");
      }
    }),
  );
});

test("selecting a destination suggestion fills the draft", () => {
  const initial = {
    ...init().model,
    suggestFor: "destination" as const,
  };
  story(
    update,
    given(initial),
    message(
      Message.SelectedSuggestion({ id: "oksigasi", label: "Oksigasi Space" }),
    ),
    model((next) => {
      expect(next.destinationDraft).toBe("Oksigasi Space");
      expect(next.suggestFor).toBe("none");
    }),
  );
});

test("isolating a layer and zooming bumps the map focus", () => {
  story(
    update,
    given(init().model),
    message(Message.IsolatedLayer({ layer: "flood" })),
    model((next) => {
      expect(next.layerFocus).toBe("flood");
    }),
    message(Message.ZoomedLayer({ layer: "flood" })),
    model((next) => {
      expect(next.mapFocus).toBe("flood");
      expect(next.focusNonce).toBe(1);
    }),
    message(Message.Recentered()),
    model((next) => {
      expect(next.mapFocus).toBe("home");
      expect(next.focusNonce).toBe(2);
    }),
  );
});

test("setting a verdict filter sticks", () => {
  story(
    update,
    given(init().model),
    message(Message.SetVerdictFilter({ filter: "allow" })),
    model((next) => {
      expect(next.verdictFilter).toBe("allow");
    }),
  );
});

test("submitting an empty report shows validation failure", () => {
  story(
    update,
    given(init().model),
    message(Message.SubmittedReport()),
    model((next) => {
      expect(next.report._tag).toBe("Failure");
    }),
  );
});

test("submitting a report sends feedback", () => {
  const initial = {
    ...init().model,
    reportDraft: "flooded underpass",
  };
  story(
    update,
    given(initial),
    message(Message.SubmittedReport()),
    model((next) => {
      expect(next.report._tag).toBe("Loading");
    }),
    Command.resolve(FetchFeedback, Message.SucceededReport()),
    model((next) => {
      expect(next.report._tag).toBe("Success");
      expect(next.reportDraft).toBe("");
    }),
  );
});

test("preference controls update the model", () => {
  story(
    update,
    given(init().model),
    message(Message.UpdatedHillComfort({ comfort: "climber" })),
    model((next) => {
      expect(next.hillComfort).toBe("climber");
    }),
    message(Message.ToggledAvoidUnlit()),
    model((next) => {
      expect(next.avoidUnlit).toBe(true);
    }),
    message(Message.ToggledPreferProtected()),
    model((next) => {
      expect(next.preferProtected).toBe(true);
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

test("typing a destination stores the draft", () => {
  story(
    update,
    given(init().model),
    message(Message.UpdatedDestination({ value: "kemang" })),
    model((next) => {
      expect(next.destinationDraft).toBe("kemang");
      expect(next.suggestFor).toBe("destination");
    }),
    Command.resolve(
      FetchSuggestions,
      Message.SucceededSuggestions({ target: "destination", suggestions: [] }),
    ),
  );
});
