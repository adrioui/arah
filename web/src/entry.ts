import { Runtime } from "foldkit";

import { Message, Model, init, update, view } from "./main.js";
import { parseShareHash } from "./share.js";

function initWithShare(): ReturnType<typeof init> {
  const base = init();
  const shared = parseShareHash(window.location.hash);
  if (shared === null) {
    return base;
  }
  return {
    ...base,
    model: {
      ...base.model,
      originDraft: shared.origin,
      destinationDraft: shared.destination,
    },
  };
}

const application = Runtime.makeApplication({
  Model,
  init: initWithShare,
  update,
  view,
  container: document.getElementById("root"),
  devTools: {
    Message,
  },
});

Runtime.run(application);
