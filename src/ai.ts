import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, Layer, Option, type Redacted } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";

const apiKey: Config.Config<Redacted.Redacted<string> | undefined> =
  Config.map(
    Config.option(Config.redacted("ARAH_AI_API_KEY")),
    Option.getOrUndefined,
  );

const apiUrl = Config.succeed(
  process.env["ARAH_AI_API_URL"] ?? "https://api-inference.bitdeer.ai",
);

const modelName = process.env["ARAH_AI_MODEL"] ?? "gpt-5.2";

const AiClientLayer = OpenAiClient.layerConfig({
  apiKey,
  apiUrl,
}).pipe(Layer.provide(FetchHttpClient.layer));

/** LanguageModel backed by the OpenAI-compatible Bitdeer endpoint. */
export const AiLanguageModelLayer = OpenAiLanguageModel.layer({
  model: modelName,
}).pipe(Layer.provide(AiClientLayer));

export { LanguageModel };