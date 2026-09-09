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
import { Button, Input } from "@foldkit/ui";
import {
  registerArahMap,
  type MapMarker,
  type MapObservation,
  type MapRoute,
} from "./mapElement.js";

registerArahMap();

const Health = Schema.Struct({
  ok: Schema.Boolean,
  provenance: Schema.String,
  snapshot: Schema.String,
  places: Schema.Number,
  online: Schema.Boolean,
});
type Health = typeof Health.Type;

const ServerPlanError = Schema.Struct({
  _tag: Schema.Literals([
    "IntentionUnreadable",
    "PlaceNotFound",
    "RouterUnavailable",
    "InvalidDepartAt",
  ]),
  query: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});

const SuggestionTarget = Schema.Literals([
  "none",
  "origin",
  "destination",
]);
type SuggestionTarget = typeof SuggestionTarget.Type;

const OverlayLayer = Schema.Literals(["flood", "closure", "weather"]);
type OverlayLayer = typeof OverlayLayer.Type;

const LayerFocus = Schema.Literals(["none", "flood", "closure", "weather"]);
type LayerFocus = typeof LayerFocus.Type;

const VerdictFilter = Schema.Literals([
  "all",
  "allow",
  "warn",
  "withhold",
  "block",
]);
type VerdictFilter = typeof VerdictFilter.Type;

const ReportKind = Schema.Literals(["hazard", "closure", "praise"]);
type ReportKind = typeof ReportKind.Type;

const ReportResponse = Schema.Struct({
  received: Schema.Boolean,
});

const DecisionAsyncData = AsyncData.Schema(DecisionOutput, Schema.String);
const HealthAsyncData = AsyncData.Schema(Health, Schema.String);
const ReportAsyncData = AsyncData.Schema(ReportResponse, Schema.String);
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
    markers: Schema.String,
    mapFocus: Schema.String,
  },
  events: {},
});

// MODEL

export const Model = Schema.Struct({
  originDraft: Schema.String,
  destinationDraft: Schema.String,
  night: Schema.Boolean,
  suggestFor: SuggestionTarget,
  suggestions: SuggestionsAsyncData.schema,
  decision: DecisionAsyncData.schema,
  health: HealthAsyncData.schema,
  maybeSelectedRouteId: Schema.Option(Schema.String),
  hiddenLayers: Schema.Array(OverlayLayer),
  layerFocus: LayerFocus,
  verdictFilter: VerdictFilter,
  mapFocus: Schema.String,
  focusNonce: Schema.Number,
  reportKind: ReportKind,
  reportDraft: Schema.String,
  report: ReportAsyncData.schema,
});
export type Model = typeof Model.Type;

// MESSAGE

const Message = defineMessageUnion({
  UpdatedOrigin: { value: Schema.String },
  UpdatedDestination: { value: Schema.String },
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
  IsolatedLayer: { layer: OverlayLayer },
  ZoomedLayer: { layer: LayerFocus },
  Recentered: {},
  SetVerdictFilter: { filter: VerdictFilter },
  UpdatedReportKind: { kind: ReportKind },
  UpdatedReportText: { value: Schema.String },
  SubmittedReport: {},
  SucceededReport: {},
  FailedReport: { error: Schema.String },
});

export { Message };
export type Message = typeof Message.Type;

// UPDATE

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
      if (model.destinationDraft.trim().length === 0) {
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
          decision: () =>
            Option.match(AsyncData.revalidate(model.decision), {
              onNone: () => DecisionAsyncData.Loading(),
              onSome: (refreshing) => refreshing,
            }),
          maybeSelectedRouteId: () => Option.none(),
        }),
        commands: [
          FetchDecision({
            origin: model.originDraft.trim(),
            destination: model.destinationDraft.trim(),
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
    IsolatedLayer: ({ layer }) => ({
      model: evo(model, {
        layerFocus: (current) => (current === layer ? "none" : layer),
      }),
    }),
    ZoomedLayer: ({ layer }) => ({
      model: evo(model, {
        focusNonce: (current) => current + 1,
        mapFocus: () => layer,
      }),
    }),
    Recentered: () => ({
      model: evo(model, {
        focusNonce: (current) => current + 1,
        mapFocus: () => "home",
      }),
    }),
    SetVerdictFilter: ({ filter }) => ({
      model: evo(model, {
        verdictFilter: () => filter,
      }),
    }),
    UpdatedReportKind: ({ kind }) => ({
      model: evo(model, { reportKind: () => kind }),
    }),
    UpdatedReportText: ({ value }) => ({
      model: evo(model, { reportDraft: () => value }),
    }),
    SubmittedReport: () => {
      if (AsyncData.isPending(model.report)) {
        return { model };
      }
      if (model.reportDraft.trim().length === 0) {
        return {
          model: evo(model, {
            report: () =>
              ReportAsyncData.Failure({ error: "Describe the report first." }),
          }),
        };
      }
      return {
        model: evo(model, {
          report: () => ReportAsyncData.Loading(),
        }),
        commands: [
          FetchFeedback({
            routeId: selectedRouteId(model),
            kind: model.reportKind,
            text: model.reportDraft.trim(),
          }),
        ],
      };
    },
    SucceededReport: () => ({
      model: evo(model, {
        report: () =>
          ReportAsyncData.Success({ data: { received: true } }),
        reportDraft: () => "",
      }),
    }),
    FailedReport: ({ error }) => ({
      model: evo(model, {
        report: () => ReportAsyncData.Failure({ error }),
      }),
    }),
  });

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    originDraft: "home",
    destinationDraft: "",
    night: false,
    suggestFor: "none",
    suggestions: SuggestionsAsyncData.Idle(),
    decision: DecisionAsyncData.Idle(),
    health: HealthAsyncData.Loading(),
    maybeSelectedRouteId: Option.none(),
    hiddenLayers: [],
    layerFocus: "none",
    verdictFilter: "all",
    mapFocus: "home",
    focusNonce: 0,
    reportKind: "hazard",
    reportDraft: "",
    report: ReportAsyncData.Idle(),
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
  origin: string;
  destination: string;
  night: boolean;
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const departAt = new Date(nowMs).toISOString();
    const body = {
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
    origin: Schema.String,
    destination: Schema.String,
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

const fetchFeedbackEffect = (args: {
  routeId: string;
  kind: ReportKind;
  text: string;
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const httpRequest = HttpClientRequest.post("/api/feedback").pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({
        routeId: args.routeId,
        kind: args.kind,
        text: args.text,
        at: new Date(nowMs).toISOString(),
      }),
    );
    const response = yield* client.execute(httpRequest);
    if (response.status !== 200) {
      const body = yield* response.text;
      return yield* Effect.fail(
        Message.FailedReport({
          error:
            body.length > 0
              ? body.slice(0, 200)
              : `Server returned ${response.status}`,
        }),
      );
    }
    return Message.SucceededReport();
  }).pipe(
    Effect.catchTag("FailedReport", (error) => Effect.succeed(error)),
    Effect.catch(() =>
      Effect.succeed(
        Message.FailedReport({ error: "Could not reach the arah API." }),
      ),
    ),
    Effect.provide(Http.layer),
  );

export const FetchFeedback = Command.define("FetchFeedback", {
  args: {
    routeId: Schema.String,
    kind: ReportKind,
    text: Schema.String,
  },
  messages: [Message.SucceededReport, Message.FailedReport],
  execute: (args) => fetchFeedbackEffect(args),
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
  focus: LayerFocus,
): ReadonlyArray<MapObservation> => {
  const hiddenSources = hidden.flatMap((layer) => layerSources[layer]);
  const focusSources =
    focus === "none" ? null : layerSources[focus];
  return decision.observations
    .filter(
      (observation) => hiddenSources.includes(observation.source) === false,
    )
    .filter(
      (observation) =>
        focusSources === null || focusSources.includes(observation.source),
    )
    .map((observation) => ({
      id: observation.id,
      source: observation.source,
      severity: observation.severity,
      polygon: observation.polygon,
      note: observation.note,
      observedAt: observation.observedAt,
    }));
};

const mapRoutes = (
  decision: DecisionOutput,
  filter: VerdictFilter,
): ReadonlyArray<MapRoute> => {
  const verdictById = new Map(
    decision.ranked.map((row) => [row.routeId, row.verdict] as const),
  );
  return decision.routes
    .filter((route) => {
      if (filter === "all") {
        return true;
      }
      const verdict = verdictById.get(route.id);
      return verdict === undefined || verdict === filter;
    })
    .map((route) => ({
      id: route.id,
      name: route.name,
      kind: route.kind,
      points: route.points,
      routeSource: route.routeSource,
    }));
};

const selectedRouteId = (model: Model): string =>
  Option.match(model.maybeSelectedRouteId, {
    onNone: () => "",
    onSome: (id) => id,
  });

const mapMarkers = (
  decision: DecisionOutput,
): ReadonlyArray<MapMarker> => [
  {
    id: "origin",
    label: decision.resolved.origin.label,
    lat: decision.resolved.origin.point.lat,
    lon: decision.resolved.origin.point.lon,
    kind: "origin",
  },
  {
    id: "destination",
    label: decision.resolved.destination.label,
    lat: decision.resolved.destination.point.lat,
    lon: decision.resolved.destination.point.lon,
    kind: "destination",
  },
];

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
            JSON.stringify(
              decision === undefined ? [] : mapRoutes(decision, model.verdictFilter),
            ),
          ),
          arahMap.Observations(
            JSON.stringify(
              decision === undefined
                ? []
                : visibleObservations(
                    decision,
                    model.hiddenLayers,
                    model.layerFocus,
                  ),
            ),
          ),
          arahMap.Selected(selectedRouteId(model)),
          arahMap.Markers(
            JSON.stringify(decision === undefined ? [] : mapMarkers(decision)),
          ),
          arahMap.MapFocus(`${model.mapFocus}:${model.focusNonce}`),
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

const statusLine = (model: Model): string =>
  AsyncData.matchDataSplitEmpty(model.health, {
    onIdle: () => "checking sources…",
    onLoading: () => "checking sources…",
    onFailure: () => "source status unknown",
    onData: (health) =>
      `${health.provenance} · ${health.places} places · ${health.online ? "online" : "registry only"}`,
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
          h.form(
            [
              h.OnSubmit(Message.SubmittedSearch()),
              h.Class("flex flex-col gap-3"),
            ],
            [
              goFields(model, h),
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

const layerPanel = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-col gap-1.5")],
    (Object.keys(layerSources) as Array<OverlayLayer>).map((layer) => {
      const hidden = model.hiddenLayers.includes(layer);
      const isolated = model.layerFocus === layer;
      return h.div(
        [h.Class("flex items-center gap-1.5")],
        [
          h.button(
            [
              h.Class(
                `flex-1 text-left px-2.5 py-1 rounded-full border text-xs font-semibold transition ${hidden ? "bg-white text-slate-400 border-slate-200" : "bg-slate-900 text-white border-slate-900"}`,
              ),
              h.OnClick(Message.ToggledLayer({ layer })),
              h.AriaPressed(hidden === false ? "true" : "false"),
            ],
            [`${hidden ? "Show" : "Hide"} ${layerLabel[layer].toLowerCase()}`],
          ),
          h.button(
            [
              h.Class(
                `px-2.5 py-1 rounded-full border text-xs font-semibold transition ${isolated ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-600 border-slate-300"}`,
              ),
              h.OnClick(Message.IsolatedLayer({ layer })),
              h.AriaPressed(isolated ? "true" : "false"),
            ],
            ["Solo"],
          ),
          h.button(
            [
              h.Class(
                "px-2.5 py-1 rounded-full border border-slate-300 bg-white text-xs font-semibold text-slate-600",
              ),
              h.OnClick(Message.ZoomedLayer({ layer })),
              h.AriaLabel(`Zoom to ${layerLabel[layer].toLowerCase()} layer`),
            ],
            ["Zoom"],
          ),
        ],
      );
    }),
  );

const legend = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600")],
    [
      h.span([h.Class("inline-flex items-center gap-1")], [
        h.span(
          [h.Class("inline-block h-2.5 w-2.5 rounded-sm bg-[#e11d48]")],
          [],
        ),
        "severe",
      ]),
      h.span([h.Class("inline-flex items-center gap-1")], [
        h.span(
          [h.Class("inline-block h-2.5 w-2.5 rounded-sm bg-[#f59e0b]")],
          [],
        ),
        "moderate",
      ]),
      h.span([h.Class("inline-flex items-center gap-1")], [
        h.span(
          [h.Class("inline-block h-2.5 w-2.5 rounded-sm bg-[#0ea5e9]")],
          [],
        ),
        "info",
      ]),
      h.span([h.Class("inline-flex items-center gap-1")], [
        h.span(
          [h.Class("inline-block h-2.5 w-2.5 rounded-sm bg-[#ea580c]")],
          [],
        ),
        "selected route",
      ]),
      h.span([h.Class("inline-flex items-center gap-1")], [
        h.span(
          [h.Class("inline-block h-2.5 w-2.5 rounded-sm bg-[#0d9488]")],
          [],
        ),
        "route",
      ]),
    ],
  );

const verdictChips = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex gap-1.5 flex-wrap")],
    (["all", "allow", "warn", "withhold", "block"] as const).map(
      (filter) =>
        h.button(
          [
            h.Class(
              `px-2.5 py-1 rounded-full border text-xs font-semibold transition ${model.verdictFilter === filter ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-600 border-slate-300"}`,
            ),
            h.OnClick(Message.SetVerdictFilter({ filter })),
            h.AriaPressed(model.verdictFilter === filter ? "true" : "false"),
          ],
          [filter],
        ),
    ),
  );

const reportForm = (
  model: Model,
  decision: DecisionOutput,
  h: HtmlBuilder<Message>,
): Html => {
  const pending = AsyncData.isPending(model.report);
  return h.form(
    [
      h.OnSubmit(Message.SubmittedReport()),
      h.Class("flex flex-col gap-2 rounded-xl border border-slate-200 p-3"),
    ],
    [
      h.p(
        [h.Class("text-xs font-semibold text-slate-700")],
        [`Report for ${(selectedRouteId(model) || decision.ranked[0]?.routeId) ?? "this ride"}`],
      ),
      h.div(
        [h.Class("flex gap-1.5")],
        (["hazard", "closure", "praise"] as const).map((kind) =>
          h.button(
            [
              h.Class(
                `px-2.5 py-1 rounded-full border text-xs font-semibold transition ${model.reportKind === kind ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-300"}`,
              ),
              h.OnClick(Message.UpdatedReportKind({ kind })),
              h.AriaPressed(model.reportKind === kind ? "true" : "false"),
            ],
            [kind],
          ),
        ),
      ),
      Input.view(
        {
          id: "report-text",
          value: model.reportDraft,
          isDisabled: pending,
          onInput: (value) => Message.UpdatedReportText({ value }),
          toView: (attributes) =>
            h.input([
              ...attributes.input,
              h.Class(
                "w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm focus:border-emerald-500 outline-none",
              ),
            ]),
        },
        h,
      ),
      Button.view(
        {
          type: "submit",
          isDisabled: pending,
          toView: (attributes) =>
            h.button(
              [
                ...attributes.button,
                h.Class(
                  "px-4 py-2 bg-slate-900 text-white text-sm font-semibold rounded-lg hover:bg-slate-700 transition data-[disabled]:opacity-50",
                ),
              ],
              [pending ? "Sending…" : "Send report"],
            ),
        },
        h,
      ),
      AsyncData.matchDataSplitEmpty(model.report, {
        onIdle: () => h.empty,
        onLoading: () => h.empty,
        onFailure: (error) =>
          h.p([h.Class("text-xs text-rose-700")], [error]),
        onData: () =>
          h.p(
            [h.Class("text-xs text-emerald-700 font-medium")],
            ["Report received. Thank you."],
          ),
      }),
    ],
  );
};

const loadingStages: ReadonlyArray<string> = [
  "Resolving places",
  "Routing",
  "Ranking routes",
];

const ghostCard = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        "snap-start shrink-0 w-64 rounded-xl border border-slate-200 bg-white p-3 flex flex-col gap-2 animate-pulse",
      ),
    ],
    [
      h.div([h.Class("h-4 w-3/4 rounded bg-slate-200")], []),
      h.div([h.Class("h-3 w-1/2 rounded bg-slate-100")], []),
      h.div([h.Class("h-3 w-2/3 rounded bg-slate-100")], []),
    ],
  );

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("flex flex-col gap-3")],
    [
      h.ul(
        [h.Class("flex flex-col gap-1.5")],
        loadingStages.map((stage) =>
          h.li(
            [h.Class("flex items-center gap-2 text-sm text-emerald-800")],
            [
              h.span(
                [h.Class("h-2 w-2 rounded-full bg-emerald-500 animate-pulse")],
                [],
              ),
              stage,
            ],
          ),
        ),
      ),
      h.div(
        [h.Class("flex gap-3 overflow-x-auto pb-1")],
        [ghostCard(h), ghostCard(h)],
      ),
    ],
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
                ["Enter places above and tap Find routes."],
              ),
            onLoading: () => loadingView(h),
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
              const visibleRanked =
                model.verdictFilter === "all"
                  ? decision.ranked
                  : decision.ranked.filter(
                      (row) => row.verdict === model.verdictFilter,
                    );
              const cards = visibleRanked
                .map((ranked) => routeCard(model, decision, ranked.routeId, h))
                .filter((card): card is Html => card !== undefined);
              const active = decision.ranked.find(
                (row) => row.routeId === selectedRouteId(model),
              );
              return h.div(
                [h.Class("flex flex-col gap-3")],
                [
                  ...(AsyncData.isRefreshing(model.decision)
                    ? [
                        h.p(
                          [h.Class("text-xs font-medium text-emerald-700")],
                          ["Updating routes…"],
                        ),
                      ]
                    : []),
                  layerPanel(model, h),
                  legend(h),
                  h.button(
                    [
                      h.Class(
                        "self-start px-3 py-1.5 rounded-full border border-slate-300 bg-white text-xs font-semibold text-slate-600",
                      ),
                      h.OnClick(Message.Recentered()),
                      h.AriaLabel("Recenter map on home area"),
                    ],
                    ["Recenter"],
                  ),
                  verdictChips(model, h),
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
                  reportForm(model, decision, h),
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
