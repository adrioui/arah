import { Effect, Exit, Schema, String } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { DecisionOutput, type Verdict } from "@arah/domain";
import {
  AsyncData,
  Command,
  CustomElement,
  Http,
  Runtime,
  type Update,
} from "foldkit";
import { type Document, type Html, type HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { evo } from "foldkit/struct";
import { Button, Input } from "@foldkit/ui";
import {
  registerArahMap,
  type MapObservation,
  type MapRoute,
} from "./mapElement.js";

registerArahMap();

const Health = Schema.Struct({
  ok: Schema.Boolean,
  provenance: Schema.String,
  snapshot: Schema.String,
  venues: Schema.Number,
  online: Schema.Boolean,
});
type Health = typeof Health.Type;

const ServerPlanError = Schema.Struct({
  _tag: Schema.Literals([
    "IntentionUnreadable",
    "PlaceNotFound",
    "RouterUnavailable",
  ]),
  query: Schema.optional(Schema.String),
});

const DecisionAsyncData = AsyncData.Schema(DecisionOutput, Schema.String);
const HealthAsyncData = AsyncData.Schema(Health, Schema.String);

const ArahMap = CustomElement.define({
  tag: "arah-map",
  properties: {
    routes: Schema.String,
    observations: Schema.String,
  },
  events: {},
});

// MODEL

export const Model = Schema.Struct({
  intention: Schema.String,
  decision: DecisionAsyncData.schema,
  health: HealthAsyncData.schema,
});
export type Model = typeof Model.Type;

// MESSAGE

const Message = defineMessageUnion({
  UpdatedIntention: { value: Schema.String },
  SubmittedIntention: {},
  SucceededPlan: { decision: DecisionOutput },
  FailedPlan: { error: Schema.String },
  SucceededHealth: { health: Health },
  FailedHealth: { error: Schema.String },
});

export { Message };
export type Message = typeof Message.Type;

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedIntention: ({ value }) => ({
      model: evo(model, {
        intention: () => value,
      }),
    }),
    SubmittedIntention: () => {
      if (AsyncData.isPending(model.decision)) {
        return { model };
      }
      if (String.isEmpty(model.intention.trim())) {
        return {
          model: evo(model, {
            decision: () =>
              DecisionAsyncData.Failure({
                error: "Type a ride first. Try \"long ride at alsut 150 min\" or \"go to oksigasi\".",
              }),
          }),
        };
      }
      return {
        model: evo(model, {
          decision: () => DecisionAsyncData.Loading(),
        }),
        commands: [FetchDecision({ text: model.intention.trim() })],
      };
    },
    SucceededPlan: ({ decision }) => ({
      model: evo(model, {
        decision: () => DecisionAsyncData.Success({ data: decision }),
      }),
    }),
    FailedPlan: ({ error }) => ({
      model: evo(model, {
        decision: () => DecisionAsyncData.Failure({ error }),
      }),
    }),
    SucceededHealth: ({ health }) => ({
      model: evo(model, {
        health: () => HealthAsyncData.Success({ data: health }),
      }),
    }),
    FailedHealth: ({ error }) => ({
      model: evo(model, {
        health: () => HealthAsyncData.Failure({ error }),
      }),
    }),
  });

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    intention: "",
    decision: DecisionAsyncData.Idle(),
    health: HealthAsyncData.Loading(),
  },
  commands: [FetchHealth()],
});

// COMMAND

const failedWithStatus = (
  response: HttpClientResponse.HttpClientResponse,
  body: string,
): Message => {
  if (response.status === 422) {
    const exit = Schema.decodeUnknownExit(
      Schema.fromJsonString(ServerPlanError),
    )(body);
    if (Exit.isSuccess(exit)) {
      if (exit.value._tag === "PlaceNotFound") {
        return Message.FailedPlan({
          error: `No place found for "${exit.value.query ?? "that place"}". Try a registry name or coordinates.`,
        });
      }
      if (exit.value._tag === "RouterUnavailable") {
        return Message.FailedPlan({
          error: "Parsed fine, but no curated ride exists for that pair yet.",
        });
      }
      return Message.FailedPlan({
        error:
          "That ride doesn't parse. Try \"long ride at alsut 150 min\" or \"go to oksigasi\".",
      });
    }
    return Message.FailedPlan({
      error: body.length > 0 ? body.slice(0, 200) : `Server returned ${response.status}`,
    });
  }
  return Message.FailedPlan({
    error: body.length > 0 ? body.slice(0, 200) : `Server returned ${response.status}`,
  });
};

const fetchDecisionEffect = (text: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const httpRequest = HttpClientRequest.post("/api/intend").pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({ text }),
    );
    const response = yield* client.execute(httpRequest);
    if (response.status !== 200) {
      return yield* Effect.fail(
        failedWithStatus(response, yield* response.text),
      );
    }
    const decision = yield* Schema.decodeUnknownEffect(DecisionOutput)(
      yield* response.json,
    ).pipe(
      Effect.mapError(() =>
        Message.FailedPlan({ error: "Could not read decision response." }),
      ),
    );
    return Message.SucceededPlan({ decision });
  }).pipe(
    Effect.catchTag("FailedPlan", (error) => Effect.succeed(error)),
    Effect.catch(() =>
      Effect.succeed(
        Message.FailedPlan({ error: "Could not reach the arah API." }),
      ),
    ),
    Effect.provide(Http.layer),
  );

export const FetchDecision = Command.define("FetchDecision", {
  args: { text: Schema.String },
  messages: [Message.SucceededPlan, Message.FailedPlan],
  execute: ({ text }) => fetchDecisionEffect(text),
});

const fetchHealth = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/api/health");
  if (response.status !== 200) {
    return yield* Effect.fail(
      Message.FailedHealth({ error: `Health check failed (${response.status})` }),
    );
  }
  const health = yield* Schema.decodeUnknownEffect(Health)(
    yield* response.json,
  ).pipe(
    Effect.mapError(() =>
      Message.FailedHealth({ error: "Could not read health response." }),
    ),
  );
  return Message.SucceededHealth({ health });
}).pipe(
  Effect.catchTag("FailedHealth", (error) => Effect.succeed(error)),
  Effect.catch(() =>
    Effect.succeed(
      Message.FailedHealth({ error: "Could not reach the arah API." }),
    ),
  ),
  Effect.provide(Http.layer),
);

export const FetchHealth = Command.define("FetchHealth", {
  messages: [Message.SucceededHealth, Message.FailedHealth],
  execute: fetchHealth,
});

// VIEW

const verdictClass = (verdict: Verdict): string => {
  switch (verdict) {
    case "allow":
      return "bg-emerald-100 text-emerald-900 border-emerald-300";
    case "warn":
      return "bg-amber-100 text-amber-900 border-amber-300";
    case "withhold":
      return "bg-orange-100 text-orange-900 border-orange-300";
    case "block":
      return "bg-rose-100 text-rose-900 border-rose-300";
  }
};

const mapRoutes = (decision: DecisionOutput): ReadonlyArray<MapRoute> =>
  decision.routes.map((route) => ({
    id: route.id,
    name: route.name,
    kind: route.kind,
    points: route.points,
    routeSource: route.routeSource,
  }));

const mapObservations = (
  decision: DecisionOutput,
): ReadonlyArray<MapObservation> =>
  decision.observations.map((observation) => ({
    id: observation.id,
    source: observation.source,
    severity: observation.severity,
    polygon: observation.polygon,
    note: observation.note,
  }));

const mapView = (decision: DecisionOutput, h: HtmlBuilder<Message>): Html => {
  const arahMap = ArahMap.withMessage(h);
  return arahMap(
    [
      h.Class("w-full h-80 rounded-xl overflow-hidden border border-slate-200"),
      arahMap.Routes(JSON.stringify(mapRoutes(decision))),
      arahMap.Observations(JSON.stringify(mapObservations(decision))),
    ],
    [],
  );
};

const rankedCard = (
  decision: DecisionOutput,
  routeId: string,
  h: HtmlBuilder<Message>,
): Html | undefined => {
  const ranked = decision.ranked.find((row) => row.routeId === routeId);
  const route = decision.routes.find((row) => row.id === routeId);
  if (ranked === undefined || route === undefined) {
    return undefined;
  }
  const meta: Array<string> = [
    `${route.distanceKm.toFixed(1)} km`,
    route.kind === "loop" ? "loop" : "point-to-point",
    route.routeSource,
  ];
  if (ranked.estimatedMinutes !== undefined) {
    meta.push(`~${ranked.estimatedMinutes} min`);
  }
  if (ranked.suggestedLaps !== undefined) {
    meta.push(`${ranked.suggestedLaps} laps`);
  }
  return h.article(
    [
      h.Class(
        "rounded-xl border bg-white/90 p-4 shadow-sm flex flex-col gap-3",
      ),
    ],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-3")],
        [
          h.div(
            [],
            [
              h.h3(
                [h.Class("text-lg font-semibold text-slate-900")],
                [ranked.routeName],
              ),
              h.p([h.Class("text-sm text-slate-600")], [meta.join(" · ")]),
            ],
          ),
          h.span(
            [
              h.Class(
                `text-xs font-semibold uppercase tracking-wide px-2 py-1 rounded border ${verdictClass(ranked.verdict)}`,
              ),
            ],
            [ranked.verdict],
          ),
        ],
      ),
      ranked.reasons.length > 0
        ? h.ul(
            [h.Class("text-sm text-slate-700 list-disc pl-5 space-y-1")],
            ranked.reasons.map((reason) => h.li([], [reason])),
          )
        : h.empty,
    ],
  );
};

const decisionView = (
  decision: DecisionOutput,
  h: HtmlBuilder<Message>,
): Html => {
  const cards = decision.ranked
    .map((ranked) => rankedCard(decision, ranked.routeId, h))
    .filter((card): card is Html => card !== undefined);
  const resolved = decision.resolved;
  const resolvedLine =
    decision.intent === "train"
      ? `${resolved.origin.label} → ${resolved.venue?.label ?? "venue"}`
      : `${resolved.origin.label} → ${resolved.destination?.label ?? "destination"}`;
  return h.section(
    [h.Class("w-full max-w-3xl flex flex-col gap-4")],
    [
      mapView(decision, h),
      h.div(
        [h.Class("rounded-xl bg-white/80 border border-slate-200 p-4")],
        [
          h.h2(
            [h.Class("text-xl font-bold text-slate-900 mb-1")],
            [decision.intent === "train" ? "Training plan" : "Go ride"],
          ),
          h.p([h.Class("text-sm text-slate-600")], [resolvedLine]),
          h.p(
            [h.Class("text-xs text-slate-500 mt-2")],
            [
              `Sources: ${decision.routeSources.join(", ")} · snapshot ${decision.mapSnapshotId}`,
            ],
          ),
        ],
      ),
      ...cards,
    ],
  );
};

const healthBanner = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.matchDataSplitEmpty(model.health, {
    onIdle: () => h.empty,
    onLoading: () =>
      h.p([h.Class("text-sm text-slate-500")], ["Checking data sources…"]),
    onFailure: (error) =>
      h.p([h.Class("text-sm text-rose-700")], [error]),
    onData: (health) =>
      h.p(
        [h.Class("text-sm text-slate-600")],
        [
          `${health.provenance} · ${health.venues} venues · ${health.online ? "online geocode" : "registry only"}`,
        ],
      ),
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "arah",
  body: h.div(
    [
      h.Class(
        "min-h-screen bg-gradient-to-br from-emerald-50 via-teal-50 to-slate-100 text-slate-900",
      ),
    ],
    [
      h.div(
        [h.Class("max-w-4xl mx-auto px-4 py-10 flex flex-col gap-8")],
        [
          h.header(
            [h.Class("flex flex-col gap-2")],
            [
              h.h1(
                [h.Class("text-4xl font-black tracking-tight text-emerald-950")],
                ["arah"],
              ),
              h.p(
                [h.Class("text-slate-600 max-w-2xl")],
                [
                  "Type one ride sentence. arah parses it, routes it, overlays live weather, and shows why on the map.",
                ],
              ),
              healthBanner(model, h),
            ],
          ),

          h.form(
            [
              h.Class(
                "rounded-2xl border border-white/60 bg-white/70 backdrop-blur p-6 shadow-sm flex flex-col gap-4",
              ),
              h.OnSubmit(Message.SubmittedIntention()),
            ],
            [
              h.div(
                [h.Class("flex flex-col gap-1")],
                [
                  h.label(
                    [h.Class("text-sm font-medium text-slate-700")],
                    ["Ride intention"],
                  ),
                  Input.view(
                    {
                      id: "ride-intention",
                      value: model.intention,
                      placeholder: "long ride at alsut 150 min",
                      onInput: (value) => Message.UpdatedIntention({ value }),
                      toView: (attributes) =>
                        h.input([
                          ...attributes.input,
                          h.Autocomplete("off"),
                          h.Class(
                            "w-full px-3 py-2 rounded-lg border border-slate-300 bg-white focus:border-emerald-500 outline-none",
                          ),
                        ]),
                    },
                    h,
                  ),
                ],
              ),
              Button.view(
                {
                  type: "submit",
                  isDisabled: AsyncData.isPending(model.decision),
                  toView: (attributes) =>
                    h.button(
                      [
                        ...attributes.button,
                        h.Class(
                          "w-full sm:w-auto px-6 py-2.5 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 transition data-[disabled]:opacity-50",
                        ),
                      ],
                      [
                        AsyncData.isPending(model.decision)
                          ? "Planning…"
                          : "Plan ride",
                      ],
                    ),
                },
                h,
              ),
            ],
          ),

          AsyncData.matchDataSplitEmpty(model.decision, {
            onIdle: () =>
              h.p(
                [h.Class("text-slate-500 text-center")],
                ["Submit a ride sentence to see routes, weather, and reasons."],
              ),
            onLoading: () =>
              h.p(
                [h.Class("text-emerald-700 font-medium text-center")],
                ["Parsing, resolving places, and ranking routes…"],
              ),
            onFailure: (error) =>
              h.div(
                [
                  h.Class(
                    "rounded-lg border border-rose-300 bg-rose-50 text-rose-800 px-4 py-3",
                  ),
                ],
                [error],
              ),
            onData: (decision) => decisionView(decision, h),
          }),
        ],
      ),
    ],
  ),
});