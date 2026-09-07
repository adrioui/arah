# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

This tree is on Effect 4 (`effect@4.0.0-rc` plus matching `@effect/*`
packages, one shared version). Single-literal `Schema.Literal` is gone: one
value uses `Schema.Literal`, several use `Schema.Literals([...])`, unions
take arrays. Unknown-input decoding returns an `Exit`
(`Schema.decodeUnknownExit`, narrowed with `Exit.isSuccess`). Typed-error
recovery is `Effect.catch`, not `Effect.catchAll`.

Runtime modules import Layers and yield services. They do not import
`make<Service>` constructors. Oxlint enforces that with
`anti-slop-effect/no-service-constructor-imports`.

HTTP follows the schema-first `HttpApi` pattern in
`node_modules/effect/ai-docs/src/51_http-server/`. Api definitions stay
separate from server implementations. Handlers are built with
`HttpApiBuilder.group` plus `handleAll`, keeping a NoDeps export so tests
can supply alternative services.
