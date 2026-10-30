// The look catalogue's entry (`/__look`, dev builds only; `index.html` beside it loads it). The
// catalogue is its own small Foldkit element with no brain and no socket; it takes its first theme
// from the address.

import "../../tokens.css";
import "./catalogue.css";
import { Runtime } from "foldkit";

import { initialOf, Model, update, view } from "./Catalogue.ts";

Runtime.run(
  Runtime.makeElement({
    Model,
    init: () => ({ model: initialOf(location.search) }),
    update,
    view,
    container: document.querySelector("#root"),
  })
);
