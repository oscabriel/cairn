// The push toggle's update. The device is checked once per load; with the permission granted, the
// subscription is re-registered with the server once per load (iOS drops them silently); the
// switch turns push on (asking for the permission from the tap) or off; the badge follows the
// root's count; a tapped notification asks the root to open its path.
import { Option } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { CheckDevice, DisablePush, EnablePush, ShowBadge } from "./Command.ts";
import type { Services } from "./Command.ts";
import { Message, OutMessage } from "./Message.ts";
import { initial, PushStatus } from "./Model.ts";
import type { Model, PushContext } from "./Model.ts";

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  Services
>;

/** The toggle at page load: it checks the device and registers the service worker. */
export const init = (): UpdateReturn => ({
  model: initial,
  commands: [CheckDevice()],
});

/** True when this browser has push and the user allowed notifications. */
export const canPush = (model: Model): boolean =>
  Option.contains(model.support, "supported") && model.permission === "granted";

/** Writes the context's badge when it differs from the last one written, once the device is known. */
const syncBadge = (model: Model): UpdateReturn =>
  Option.isNone(model.support) || model.context.badge === model.shownBadge
    ? { model }
    : {
        model: modifyFields(model, { shownBadge: () => model.context.badge }),
        commands: [ShowBadge({ count: model.context.badge })],
      };

/**
 * Takes the root's context; a badge count other than the one this load last wrote goes to the app
 * icon once the device was checked, so the first one clears a badge the service worker left (T37).
 */
export const inform = (model: Model, context: PushContext): UpdateReturn =>
  syncBadge(modifyFields(model, { context: () => context }));

/** The toggle's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CheckedDevice: ({ deviceId, permission, support, wanted }) => {
      const pushable =
        support === "supported" && permission === "granted" && wanted;

      return syncBadge(
        modifyFields(model, {
          support: () => Option.some(support),
          permission: () => permission,
          deviceId: () => Option.some(deviceId),
          // Without push, the permission or the user's wish there is nothing to re-check.
          synced: () => !pushable,
          status: (status) => (pushable ? status : PushStatus.Off()),
        })
      );
    },

    SyncedSubscription: ({ subscribed }) => ({
      model: modifyFields(model, {
        synced: () => true,
        status: () => (subscribed ? PushStatus.On() : PushStatus.Off()),
      }),
    }),

    ToggledNotifications: ({ isChecked }) => {
      if (!isChecked) {
        return {
          model: modifyFields(model, { status: () => PushStatus.Working() }),
          commands: [DisablePush()],
        };
      }

      return Option.match(model.context.vapidKey, {
        onNone: () => ({
          model: modifyFields(model, {
            status: () =>
              PushStatus.Failed({
                message:
                  "Cairn is still connecting, so it has no push key yet. Try again in a moment.",
              }),
          }),
        }),
        onSome: (vapidKey) => ({
          model: modifyFields(model, { status: () => PushStatus.Working() }),
          commands: [EnablePush({ vapidKey })],
        }),
      });
    },

    SucceededEnable: () => ({
      model: modifyFields(model, {
        permission: () => "granted" as const,
        synced: () => true,
        status: () => PushStatus.On(),
      }),
    }),

    SucceededDisable: () => ({
      model: modifyFields(model, { status: () => PushStatus.Off() }),
    }),

    FailedPush: ({ message: text, permission }) => ({
      model: modifyFields(model, {
        permission: () => permission,
        synced: () => true,
        status: () => PushStatus.Failed({ message: text }),
      }),
    }),

    ReportedPresence: () => ({ model }),

    ShowedBadge: ({ count }) => ({
      model: modifyFields(model, { shownBadge: () => count }),
    }),

    ReceivedOpenRequest: ({ path }) => ({
      model,
      outMessage: OutMessage.RequestedNavigate({ path }),
    }),
  });
