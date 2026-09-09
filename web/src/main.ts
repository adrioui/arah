import { Clock, Effect, Exit, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  DecisionOutput,
  PlaceSearchResponse,
  PlaceSuggestion,
  TrainSession,
  type Verdict,
} from "@arah/domain";
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
import { Button, Input, Select } from "@foldkit/ui";
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
    "InvalidRideDuration",
    "InvalidDepartAt",
  ]),
  query: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});

const Mode = Schema.Literals(["train", "go"]);
type Mode = typeof Mode.Type;

const SuggestionTarget = Schema.Literals([
  "none",
  "venue",
  "origin",
  "destination",
]);
type SuggestionTarget = typeof SuggestionTarget.Type;

const OverlayLayer = Schema.Literals(["flood", "closure", "weather"]);
type OverlayLayer = typeof OverlayLayer.Type;

const DecisionAsyncData = AsyncData.Schema(DecisionOutput, Schema.String);
const HealthAsyncData = AsyncData.Schema(Health, Schema.String);
const SuggestionsAsyncData = AsyncData.Schema(
  Schema.Array(PlaceSuggestion),
  Schema.String,
);

const ArahMap = CustomElement.define({
  tag: "arah-map",
  properties: {
    routes: Schema.String,
    observations: Schema.String,
    selected: Schema.String,
  },
  events: {},
});

// MODEL

export const Model = Schema.Struct({
  mode: Mode,
  venueDraft: Schema.String,
  originDraft: Schema.String,
  destinationDraft: Schema.String,
  session: TrainSession,
  minutes: Schema.Number,
  night: Schema.Boolean,
  suggestFor: SuggestionTarget,
  suggestions: SuggestionsAsyncData.schema,
  decision: DecisionAsyncData.schema,
  health: HealthAsyncData.schema,
  maybeSelectedRouteId: Schema.Option(Schema.String),
  hiddenLayers: Schema.Array(OverlayLayer),
});
export type Model = typeof Model.Type;

// MESSAGE

const Message = defineMessageUnion({
  SelectedMode: { mode: Mode },
  UpdatedVenue: { value: Schema.String },
  UpdatedOrigin: { value: Schema.String },
  UpdatedDestination: { value: Schema.String },
  UpdatedSession: { session: TrainSession },
  UpdatedMinutes: { value: Schema.String },
  ClickedMinutesIncrement: {},
  ClickedMinutesDecrement: {},
  ToggledNight: {},
  SucceededSuggestions: {
    target: SuggestionTarget,
    suggestions: Schema.Array(PlaceSuggestion),
  },
  FailedSuggestions: { error: Schema.String },
  SelectedSuggestion: { id: Schema.String, label: Schema.String },
  DismissedSuggestions: {},
  SubmittedSearch: {},
  SucceededPlan: { decision: DecisionOutput },
  FailedPlan: { error: Schema.String },
  SucceededHealth: { health: Health },
  FailedHealth: { error: Schema.String },
  SelectedRoute: { routeId: Schema.String },
  ToggledLayer: { layer: OverlayLayer },
});

export { Message };
export type Message = typeof Message.Type;

// UPDATE

const MIN_MINUTES = 15;
const MAX_MINUTES = 1440;
const MINUTES_STEP = 15;

const requestSuggestions = (
  model: Model,
  target: SuggestionTarget,
  value: string,
): Update.Return<Model, Message> => {
  if (value.trim().length === 0) {
    return {
      model: evo(model, {
        suggestFor: () => "none" as const,
        suggestions: () => SuggestionsAsyncData.Idle(),
      }),
    };
  }
  return {
    model: evo(model, {
      suggestFor: () => target,
      suggestions: () => SuggestionsAsyncData.Loading(),
    }),
    commands: [FetchSuggestions({ target, q: value.trim() })],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SelectedMode: ({ mode }) => ({
      model: evo(model, {
        mode: () => mode,
        suggestFor: () => "none" as const,
        suggestions: () => SuggestionsAsyncData.Idle(),
      }),
    }),
    UpdatedVenue: ({ value }) => {
      const request = requestSuggestions(model, "venue", value);
      return {
        ...request,
        model: evo(request.model, { venueDraft: () => value }),
      };
    },
    UpdatedOrigin: ({ value }) => {
      const request = requestSuggestions(model, "origin", value);
      return {
        ...request,
        model: evo(request.model, { originDraft: () => value }),
      };
    },
    UpdatedDestination: ({ value }) => {
      const request = requestSuggestions(model, "destination", value);
      return {
        ...request,
        model: evo(request.model, { destinationDraft: () => value }),
      };
    },
    UpdatedSession: ({ session }) => ({
      model: evo(model, { session: () => session }),
    }),
    UpdatedMinutes: ({ value }) => {
      const parsed = Number(value);
      if (
        Number.isFinite(parsed) === false ||
        parsed < MIN_MINUTES ||
        parsed > MAX_MINUTES
      ) {
        return { model };
      }
      return {
        model: evo(model, { minutes: () => Math.round(parsed) }),
      };
    },
    ClickedMinutesIncrement: () => ({
      model: evo(model, {
        minutes: (current) => Math.min(MAX_MINUTES, current + MINUTES_STEP),
      }),
    }),
    ClickedMinutesDecrement: () => ({
      model: evo(model, {
        minutes: (current) => Math.max(MIN_MINUTES, current - MINUTES_STEP),
      }),
    }),
    ToggledNight: () => ({
      model: evo(model, { night: (current) => current === false }),
    }),
    SucceededSuggestions: ({ target, suggestions }) => {
      if (target !== model.suggestFor) {
        return { model };
      }
      return {
        model: evo(model, {
          suggestions: () =>
            SuggestionsAsyncData.Success({ data: [...suggestions] }),
        }),
      };
    },
    FailedSuggestions: ({ error }) => ({
      model: evo(model, {
        suggestions: () => SuggestionsAsyncData.Failure({ error }),
      }),
    }),
    SelectedSuggestion: ({ label }) => {
      if (model.suggestFor === "venue") {
        return {
          model: evo(model, {
            venueDraft: () => label,
            suggestFor: () => "none" as const,
            suggestions: () => SuggestionsAsyncData.Idle(),
          }),
        };
      }
      if (model.suggestFor === "origin") {
        return {
          model: evo(model, {
            originDraft: () => label,
            suggestFor: () => "none" as const,
            suggestions: () => SuggestionsAsyncData.Idle(),
          }),
        };
      }
      if (model.suggestFor === "destination") {
        return {
          model: evo(model, {
            destinationDraft: () => label,
            suggestFor: () => "none" as const,
            suggestions: () => SuggestionsAsyncData.Idle(),
          }),
        };
      }
      return { model };
    },
    DismissedSuggestions: () => ({
      model: evo(model, {
        suggestFor: () => "none" as const,
        suggestions: () => SuggestionsAsyncData.Idle(),
      }),
    }),
    SubmittedSearch: () => {
      if (AsyncData.isPending(model.decision)) {
        return { model };
      }
      if (model.mode === "train" && model.venueDraft.trim().length === 0) {
        return {
          model: evo(model, {
            decision: () =>
              DecisionAsyncData.Failure({
                error: "Enter a training venue. Try alsut, binloop, or kemang.",
              }),
          }),
        };
      }
      if (model.mode === "go" && model.destinationDraft.trim().length === 0) {
        return {
          model: evo(model, {
            decision: () =>
              DecisionAsyncData.Failure({
                error: "Enter a destination. Try oksigasi, kemang, or senayan.",
              }),
          }),
        };
      }
      return {
        model: evo(model, {
          decision: () => DecisionAsyncData.Loading(),
          maybeSelectedRouteId: () => Option.none(),
        }),
        commands: [
          FetchDecision({
            kind: model.mode,
            venue: model.venueDraft.trim(),
            origin: model.originDraft.trim(),
            destination: model.destinationDraft.trim(),
            session: model.session,
            minutes: model.minutes,
            night: model.night,
          }),
        ],
      };
    },
    SucceededPlan: ({ decision }) => {
      const first = decision.ranked[0];
      return {
        model: evo(model, {
          decision: () => DecisionAsyncData.Success({ data: decision }),
          maybeSelectedRouteId: () =>
            first === undefined ? Option.none() : Option.some(first.routeId),
        }),
      };
    },
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
    SelectedRoute: ({ routeId }) => ({
      model: evo(model, {
        maybeSelectedRouteId: () => Option.some(routeId),
      }),
    }),
    ToggledLayer: ({ layer }) => ({
      model: evo(model, {
        hiddenLayers: (current) =>
          current.includes(layer)
            ? current.filter((entry) => entry !== layer)
            : [...current, layer],
      }),
    }),
  });

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    mode: "train",
    venueDraft: "",
    originDraft: "home",
    destinationDraft: "",
    session: "long",
    minutes: 60,
    night: false,
    suggestFor: "none",
    suggestions: SuggestionsAsyncData.Idle(),
    decision: DecisionAsyncData.Idle(),
    health: HealthAsyncData.Loading(),
    maybeSelectedRouteId: Option.none(),
    hiddenLayers: [],
  },
  commands: [FetchHealth()],
});

// COMMAND

const failedPlanWithStatus = (
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
          error: "Parsed fine, but no ride exists for that pair yet.",
        });
      }
      if (exit.value._tag === "InvalidRideDuration") {
        return Message.FailedPlan({
          error: "Training minutes must stay between 1 and 1440.",
        });
      }
      return Message.FailedPlan({
        error: exit.value.detail ?? "That ride does not parse yet.",
      });
    }
  }
  return Message.FailedPlan({
    error:
      body.length > 0
        ? body.slice(0, 200)
        : `Server returned ${response.status}`,
  });
};

const fetchDecisionEffect = (args: {
  kind: Mode;
  venue: string;
  origin: string;
  destination: string;
  session: TrainSession;
  minutes: number;
  night: boolean;
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const departAt = new Date(nowMs).toISOString();
    const body =
      args.kind === "train"
        ? {
            kind: "train" as const,
            venue: args.venue,
            session: args.session,
            minutes: args.minutes,
            departAt,
            night: args.night,
          }
        : {
            kind: "go" as const,
            origin: args.origin.length > 0 ? args.origin : "home",
            destination: args.destination,
            departAt,
            night: args.night,
          };
    const httpRequest = HttpClientRequest.post("/api/decide").pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* client.execute(httpRequest);
    if (response.status !== 200) {
      return yield* Effect.fail(
        failedPlanWithStatus(response, yield* response.text),
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
  args: {
    kind: Mode,
    venue: Schema.String,
    origin: Schema.String,
    destination: Schema.String,
    session: TrainSession,
    minutes: Schema.Number,
    night: Schema.Boolean,
  },
  messages: [Message.SucceededPlan, Message.FailedPlan],
  execute: (args) => fetchDecisionEffect(args),
});

const fetchSuggestionsEffect = (target: SuggestionTarget, q: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(
      `/api/places?q=${encodeURIComponent(q)}`,
    );
    if (response.status !== 200) {
      return yield* Effect.fail(
        Message.FailedSuggestions({
          error: `Place search failed (${response.status})`,
        }),
      );
    }
    const body = yield* Schema.decodeUnknownEffect(PlaceSearchResponse)(
      yield* response.json,
    ).pipe(
      Effect.mapError(() =>
        Message.FailedSuggestions({ error: "Could not read place results." }),
      ),
    );
    return Message.SucceededSuggestions({
      target,
      suggestions: [...body.suggestions],
    });
  }).pipe(
    Effect.catchTag("FailedSuggestions", (error) => Effect.succeed(error)),
    Effect.catch(() =>
      Effect.succeed(
        Message.FailedSuggestions({ error: "Could not reach the arah API." }),
      ),
    ),
    Effect.provide(Http.layer),
  );

export const FetchSuggestions = Command.define("FetchSuggestions", {
  args: { target: SuggestionTarget, q: Schema.String },
  messages: [Message.SucceededSuggestions, Message.FailedSuggestions],
  execute: ({ target, q }) => fetchSuggestionsEffect(target, q),
  interrupt: true,
});

const fetchHealth = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/api/health");
  if (response.status !== 200) {
    return yield* Effect.fail(
      Message.FailedHealth({
        error: `Health check failed (${response.status})`,
      }),
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

const layerSources: Record<OverlayLayer, ReadonlyArray<string>> = {
  flood: ["flood"],
  closure: ["closure"],
  weather: ["bmkg", "nowcast", "air"],
};

const layerLabel: Record<OverlayLayer, string> = {
  flood: "Flood",
  closure: "Closures",
  weather: "Weather",
};

const visibleObservations = (
  decision: DecisionOutput,
  hidden: ReadonlyArray<OverlayLayer>,
): ReadonlyArray<MapObservation> => {
  const hiddenSources = hidden.flatMap((layer) => layerSources[layer]);
  return decision.observations
    .filter(
      (observation) => hiddenSources.includes(observation.source) === false,
    )
    .map((observation) => ({
      id: observation.id,
      source: observation.source,
      severity: observation.severity,
      polygon: observation.polygon,
      note: observation.note,
    }));
};

const mapRoutes = (decision: DecisionOutput): ReadonlyArray<MapRoute> =>
  decision.routes.map((route) => ({
    id: route.id,
    name: route.name,
    kind: route.kind,
    points: route.points,
    routeSource: route.routeSource,
  }));

const selectedRouteId = (model: Model): string =>
  Option.match(model.maybeSelectedRouteId, {
    onNone: () => "",
    onSome: (id) => id,
  });

const mapHost = (
  model: Model,
  decision: DecisionOutput | undefined,
  h: HtmlBuilder<Message>,
): Html => {
  const arahMap = ArahMap.withMessage(h);
  return h.div(
    [h.Class("absolute inset-0")],
    [
      arahMap(
        [
          h.Class("block h-full w-full"),
          arahMap.Routes(
            JSON.stringify(decision === undefined ? [] : mapRoutes(decision)),
          ),
          arahMap.Observations(
            JSON.stringify(
              decision === undefined
                ? []
                : visibleObservations(decision, model.hiddenLayers),
            ),
          ),
          arahMap.Selected(selectedRouteId(model)),
        ],
        [],
      ),
    ],
  );
};

const suggestionList = (
  model: Model,
  target: SuggestionTarget,
  h: HtmlBuilder<Message>,
): Html => {
  if (model.suggestFor !== target) {
    return h.empty;
  }
  return AsyncData.matchDataSplitEmpty(model.suggestions, {
    onIdle: () => h.empty,
    onLoading: () =>
      h.p([h.Class("text-xs text-slate-500 px-1")], ["Searching places…"]),
    onFailure: () => h.empty,
    onData: (suggestions) => {
      if (suggestions.length === 0) {
        return h.empty;
      }
      return h.ul(
        [
          h.Class(
            "rounded-lg border border-slate-200 bg-white shadow-sm divide-y divide-slate-100",
          ),
        ],
        suggestions.map((suggestion) =>
          h.keyed("li")(
            suggestion.id,
            [],
            [
              h.button(
                [
                  h.Class(
                    "w-full text-left px-3 py-2 hover:bg-emerald-50 transition",
                  ),
                  h.OnClick(
                    Message.SelectedSuggestion({
                      id: suggestion.id,
                      label: suggestion.label,
                    }),
                  ),
                ],
                [
                  h.p(
                    [h.Class("text-sm font-medium text-slate-900")],
                    [suggestion.label],
                  ),
                  h.p([h.Class("text-xs text-slate-500")], [suggestion.kind]),
                ],
              ),
            ],
          ),
        ),
      );
    },
  });
};

const placeField = (
  model: Model,
  target: Exclude<SuggestionTarget, "none">,
  id: string,
  label: string,
  placeholder: string,
  value: string,
  toMessage: (value: string) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("flex flex-col gap-1")],
    [
      h.label(
        [
          h.Class(
            "text-xs font-semibold uppercase tracking-wide text-slate-500",
          ),
        ],
        [label],
      ),
      Input.view(
        {
          id,
          value,
          placeholder,
          isDisabled: AsyncData.isPending(model.decision),
          onInput: (next) => toMessage(next),
          toView: (attributes) =>
            h.input([
              ...attributes.input,
              h.Autocomplete("off"),
              h.Class(
                "w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:border-emerald-500 outline-none",
              ),
            ]),
        },
        h,
      ),
      suggestionList(model, target, h),
    ],
  );

const sessionOptions: ReadonlyArray<{ value: TrainSession; label: string }> = [
  { value: "long", label: "Long" },
  { value: "tempo", label: "Tempo" },
  { value: "brisk", label: "Brisk" },
  { value: "recovery", label: "Recovery" },
];

const trainFields = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-col gap-3")],
    [
      placeField(
        model,
        "venue",
        "venue-search",
        "Training venue",
        "alsut, binloop, kemang…",
        model.venueDraft,
        (value) => Message.UpdatedVenue({ value }),
        h,
      ),
      h.div(
        [h.Class("grid grid-cols-2 gap-3")],
        [
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.label(
                [
                  h.Class(
                    "text-xs font-semibold uppercase tracking-wide text-slate-500",
                  ),
                ],
                ["Session"],
              ),
              Select.view(
                {
                  id: "train-session",
                  value: model.session,
                  isDisabled: AsyncData.isPending(model.decision),
                  onChange: (value) =>
                    Message.UpdatedSession({
                      session:
                        sessionOptions.find((option) => option.value === value)
                          ?.value ?? "long",
                    }),
                  toView: (attributes) =>
                    h.select(
                      [
                        ...attributes.select,
                        h.Class(
                          "w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:border-emerald-500 outline-none",
                        ),
                      ],
                      sessionOptions.map((option) =>
                        h.option(
                          [
                            h.Value(option.value),
                            ...(option.value === model.session
                              ? [h.Selected(true)]
                              : []),
                          ],
                          [option.label],
                        ),
                      ),
                    ),
                },
                h,
              ),
            ],
          ),
          h.div(
            [h.Class("flex flex-col gap-1")],
            [
              h.label(
                [
                  h.Class(
                    "text-xs font-semibold uppercase tracking-wide text-slate-500",
                  ),
                ],
                ["Minutes"],
              ),
              h.div(
                [h.Class("flex items-center gap-1")],
                [
                  h.button(
                    [
                      h.Class(
                        "px-2.5 py-2 rounded-lg border border-slate-300 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50",
                      ),
                      h.OnClick(Message.ClickedMinutesDecrement()),
                      h.AriaLabel("Fewer minutes"),
                    ],
                    ["−"],
                  ),
                  Input.view(
                    {
                      id: "train-minutes",
                      value: String(model.minutes),
                      type: "number",
                      isDisabled: AsyncData.isPending(model.decision),
                      onInput: (value) => Message.UpdatedMinutes({ value }),
                      toView: (attributes) =>
                        h.input([
                          ...attributes.input,
                          h.Class(
                            "w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-center focus:border-emerald-500 outline-none",
                          ),
                        ]),
                    },
                    h,
                  ),
                  h.button(
                    [
                      h.Class(
                        "px-2.5 py-2 rounded-lg border border-slate-300 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50",
                      ),
                      h.OnClick(Message.ClickedMinutesIncrement()),
                      h.AriaLabel("More minutes"),
                    ],
                    ["+"],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      h.button(
        [
          h.Class(
            `self-start px-3 py-1.5 rounded-full border text-xs font-semibold transition ${model.night ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-300"}`,
          ),
          h.OnClick(Message.ToggledNight()),
          h.AriaPressed(model.night ? "true" : "false"),
        ],
        [model.night ? "Night ride on" : "Night ride off"],
      ),
    ],
  );

const goFields = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-col gap-3")],
    [
      placeField(
        model,
        "origin",
        "origin-search",
        "From",
        "home",
        model.originDraft,
        (value) => Message.UpdatedOrigin({ value }),
        h,
      ),
      placeField(
        model,
        "destination",
        "destination-search",
        "To",
        "oksigasi, kemang, senayan…",
        model.destinationDraft,
        (value) => Message.UpdatedDestination({ value }),
        h,
      ),
      h.button(
        [
          h.Class(
            `self-start px-3 py-1.5 rounded-full border text-xs font-semibold transition ${model.night ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-300"}`,
          ),
          h.OnClick(Message.ToggledNight()),
          h.AriaPressed(model.night ? "true" : "false"),
        ],
        [model.night ? "Night ride on" : "Night ride off"],
      ),
    ],
  );

const modeTab = (
  model: Model,
  mode: Mode,
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Class(
        `flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition ${model.mode === mode ? "bg-emerald-600 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`,
      ),
      h.OnClick(Message.SelectedMode({ mode })),
      h.AriaPressed(model.mode === mode ? "true" : "false"),
    ],
    [label],
  );

const statusLine = (model: Model): string =>
  AsyncData.matchDataSplitEmpty(model.health, {
    onIdle: () => "checking sources…",
    onLoading: () => "checking sources…",
    onFailure: () => "source status unknown",
    onData: (health) =>
      `${health.provenance} · ${health.venues} venues · ${health.online ? "online" : "registry only"}`,
  });

const searchHeader = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class("absolute inset-x-0 top-0 z-10 p-3 sm:p-4")],
    [
      h.div(
        [
          h.Class(
            "max-w-2xl mx-auto rounded-2xl border border-white/60 bg-white/95 shadow-lg backdrop-blur p-4 flex flex-col gap-3",
          ),
        ],
        [
          h.div(
            [h.Class("flex items-baseline justify-between gap-3")],
            [
              h.h1(
                [
                  h.Class(
                    "text-2xl font-black tracking-tight text-emerald-950",
                  ),
                ],
                ["arah"],
              ),
              h.p([h.Class("text-xs text-slate-500")], [statusLine(model)]),
            ],
          ),
          h.div(
            [h.Class("flex gap-1 rounded-xl bg-slate-100 p-1")],
            [
              modeTab(model, "train", "Train", h),
              modeTab(model, "go", "Go", h),
            ],
          ),
          h.form(
            [
              h.OnSubmit(Message.SubmittedSearch()),
              h.Class("flex flex-col gap-3"),
            ],
            [
              model.mode === "train"
                ? trainFields(model, h)
                : goFields(model, h),
              Button.view(
                {
                  type: "submit",
                  isDisabled: AsyncData.isPending(model.decision),
                  toView: (attributes) =>
                    h.button(
                      [
                        ...attributes.button,
                        h.Class(
                          "w-full px-6 py-2.5 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 transition data-[disabled]:opacity-50",
                        ),
                      ],
                      [
                        AsyncData.isPending(model.decision)
                          ? "Planning…"
                          : "Find routes",
                      ],
                    ),
                },
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  );

const routeCard = (
  model: Model,
  decision: DecisionOutput,
  routeId: string,
  h: HtmlBuilder<Message>,
): Html | undefined => {
  const ranked = decision.ranked.find((row) => row.routeId === routeId);
  const route = decision.routes.find((row) => row.id === routeId);
  if (ranked === undefined || route === undefined) {
    return undefined;
  }
  const selected = selectedRouteId(model) === routeId;
  const meta: Array<string> = [
    `${route.distanceKm.toFixed(1)} km`,
    route.kind === "loop" ? "loop" : "point-to-point",
    route.routeSource,
  ];
  if (ranked.estimatedMinutes !== undefined) {
    meta.push(`~${Math.round(ranked.estimatedMinutes)} min`);
  }
  return h.button(
    [
      h.Class(
        `snap-start shrink-0 w-64 text-left rounded-xl border p-3 shadow-sm flex flex-col gap-2 transition ${selected ? "bg-emerald-50 border-emerald-500 ring-2 ring-emerald-500/40" : "bg-white border-slate-200"}`,
      ),
      h.OnClick(Message.SelectedRoute({ routeId })),
    ],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-2")],
        [
          h.p(
            [h.Class("text-sm font-semibold text-slate-900")],
            [ranked.routeName],
          ),
          h.span(
            [
              h.Class(
                `text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border ${verdictClass(ranked.verdict)}`,
              ),
            ],
            [ranked.verdict],
          ),
        ],
      ),
      h.p([h.Class("text-xs text-slate-600")], [meta.join(" · ")]),
    ],
  );
};

const layerToggles = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex gap-1.5 flex-wrap")],
    (["flood", "closure", "weather"] as const).map((layer) => {
      const hidden = model.hiddenLayers.includes(layer);
      return h.button(
        [
          h.Class(
            `px-2.5 py-1 rounded-full border text-xs font-semibold transition ${hidden ? "bg-white text-slate-400 border-slate-200" : "bg-slate-900 text-white border-slate-900"}`,
          ),
          h.OnClick(Message.ToggledLayer({ layer })),
          h.AriaPressed(hidden === false ? "true" : "false"),
        ],
        [`${hidden ? "Show" : "Hide"} ${layerLabel[layer].toLowerCase()}`],
      );
    }),
  );

const routeSheet = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class(
        "absolute inset-x-0 bottom-0 z-10 flex justify-center p-3 sm:p-4 pointer-events-none",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "pointer-events-auto w-full max-w-2xl max-h-[44dvh] overflow-y-auto rounded-2xl border border-white/60 bg-white/95 shadow-lg backdrop-blur p-4",
          ),
        ],
        [
          AsyncData.matchDataSplitEmpty(model.decision, {
            onIdle: () =>
              h.p(
                [h.Class("text-sm text-slate-500 text-center")],
                ["Pick a mode, enter places, and tap Find routes."],
              ),
            onLoading: () =>
              h.p(
                [h.Class("text-sm text-emerald-700 font-medium text-center")],
                ["Resolving places and ranking routes…"],
              ),
            onFailure: (error) =>
              h.div(
                [
                  h.Class(
                    "rounded-lg border border-rose-300 bg-rose-50 text-rose-800 px-4 py-3 text-sm",
                  ),
                ],
                [error],
              ),
            onData: (decision) => {
              const cards = decision.ranked
                .map((ranked) => routeCard(model, decision, ranked.routeId, h))
                .filter((card): card is Html => card !== undefined);
              const active = decision.ranked.find(
                (row) => row.routeId === selectedRouteId(model),
              );
              return h.div(
                [h.Class("flex flex-col gap-3")],
                [
                  layerToggles(model, h),
                  cards.length > 0
                    ? h.div(
                        [h.Class("flex gap-3 overflow-x-auto pb-1 snap-x")],
                        cards,
                      )
                    : h.p(
                        [h.Class("text-sm text-slate-500")],
                        ["No routes ranked."],
                      ),
                  active !== undefined && active.reasons.length > 0
                    ? h.ul(
                        [
                          h.Class(
                            "text-sm text-slate-700 list-disc pl-5 space-y-1",
                          ),
                        ],
                        active.reasons.map((reason) => h.li([], [reason])),
                      )
                    : h.empty,
                  h.p(
                    [h.Class("text-xs text-slate-500")],
                    [
                      `Sources: ${decision.routeSources.join(", ")} · snapshot ${decision.mapSnapshotId}`,
                    ],
                  ),
                ],
              );
            },
          }),
        ],
      ),
    ],
  );

const currentDecision = (model: Model): DecisionOutput | undefined =>
  AsyncData.matchDataSplitEmpty(model.decision, {
    onIdle: () => undefined,
    onLoading: () => undefined,
    onFailure: () => undefined,
    onData: (decision) => decision,
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "arah",
  body: h.div(
    [
      h.Class(
        "relative h-[100dvh] w-full overflow-hidden bg-slate-100 text-slate-900",
      ),
    ],
    [
      mapHost(model, currentDecision(model), h),
      searchHeader(model, h),
      routeSheet(model, h),
    ],
  ),
});
