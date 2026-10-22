// Every HTTP route and the global guard (a seam: the integrator adds each domain's route layer
// here, for example `shell/ShellSnapshotRoute.ts` or `attachments/UploadRoute.ts`). Specific
// routes win over the static `GET /*`, whatever their order in this list.
import { Layer } from "effect";

import { AttachmentRoute } from "../attachments/AttachmentRoute.ts";
import { UploadRoute } from "../attachments/UploadRoute.ts";
import { EntryImageRoute } from "../brain/EntryImageRoute.ts";
import { ExecutorCallbackRoute } from "../executor/ExecutorCallbackRoute.ts";
import { ShellSnapshotRoute } from "../shell/ShellSnapshotRoute.ts";
import { Guard } from "./Guard.ts";
import { HealthRoute } from "./Health.ts";
import { AuthRoute } from "./Identity.ts";
import { StaticRoutes } from "./Static.ts";
import { WsRoute } from "./Ws.ts";

/** The router's contents. */
export const Routes = Layer.mergeAll(
  Guard,
  AuthRoute,
  HealthRoute,
  WsRoute,
  ShellSnapshotRoute,
  EntryImageRoute,
  UploadRoute,
  AttachmentRoute,
  ExecutorCallbackRoute,
  StaticRoutes
);
