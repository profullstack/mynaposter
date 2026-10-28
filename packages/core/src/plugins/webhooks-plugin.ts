/**
 * The webhook relay, as a bundled plugin: after a post goes out (or fails),
 * tell myna cloud, which delivers post.published / post.failed to this
 * account's webhook endpoints. Does nothing unless the relay is on
 * (`myna webhooks relay on`, or adding an endpoint from the CLI), and never
 * affects the post: by the time it runs the post is already out.
 */
import type { MynaPlugin, PostedEvent } from "./types.ts";
import { postEvents, relayEvents, relayOn } from "../store/webhooks.ts";

export const webhooksPlugin: MynaPlugin = {
  id: "webhooks",
  name: "Webhooks",
  description: "Reports posts to your myna cloud webhooks (post.published, post.failed).",

  async afterPost(event: PostedEvent): Promise<string | void> {
    if (!relayOn()) return;
    const queued = await relayEvents(postEvents(event));
    if (queued === null) return "could not reach myna cloud; this post's webhook events were not sent";
    if (queued > 0) return `queued ${queued} webhook deliver${queued === 1 ? "y" : "ies"}`;
  },
};

export default webhooksPlugin;
