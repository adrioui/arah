import { Command, given, message, model, story } from "foldkit/story";
import { expect, test } from "vitest";

import { FetchDecision, Message, init, update } from "./main.js";

test("submitting a valid intention enters loading", () => {
  const initial = {
    ...init().model,
    intention: "long ride at alsut 150 min",
  };
  story(
    update,
    given(initial),
    message(Message.SubmittedIntention()),
    model((next) => {
      expect(next.decision._tag).toBe("Loading");
    }),
    Command.resolve(
      FetchDecision,
      Message.FailedPlan({ error: "cancelled in test" }),
    ),
  );
});

test("submitting with empty intention shows validation failure", () => {
  story(
    update,
    given({
      ...init().model,
      intention: "   ",
    }),
    message(Message.SubmittedIntention()),
    model((next) => {
      expect(next.decision._tag).toBe("Failure");
      if (next.decision._tag === "Failure") {
        expect(next.decision.error).toContain("Type a ride");
      }
    }),
  );
});

test("updated intention stores typed state", () => {
  story(
    update,
    given(init().model),
    message(Message.UpdatedIntention({ value: "go to oksigasi" })),
    model((next) => {
      expect(next.intention).toBe("go to oksigasi");
    }),
  );
});