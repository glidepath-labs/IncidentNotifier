import { App, ExpressReceiver } from "@slack/bolt";

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SIE_CHANNEL_NAME = "service-impacting-events",
  DM_NOTE = "Heads up: this channel is used for company-wide service-impacting updates. We keep everyone added so you don’t miss critical notices."
} = process.env;

// ExpressReceiver gives us an HTTP server with the /slack/events endpoint
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});

// simple healthcheck
receiver.router.get("/", (_req, res) => res.status(200).send("ok"));

// helpers
async function getChannelIdByName(client, name) {
  let cursor;
  while (true) {
    const resp = await client.conversations.list({
      types: "public_channel,private_channel",
      limit: 1000,
      cursor
    });
    const hit = resp.channels.find(c => c.name === name);
    if (hit) return hit.id;
    cursor = resp.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  throw new Error(`Channel not found: ${name}`);
}

async function ensureInvite(client, userId, channelId) {
  try {
    await client.conversations.invite({ channel: channelId, users: userId });
  } catch (e) {
    const code = e?.data?.error;
    if (code !== "already_in_channel" && code !== "cant_invite_self") {
      console.error("invite error", code);
    }
  }
  try {
    const { channel } = await client.conversations.open({ users: userId });
    await client.chat.postMessage({ channel: channel.id, text: DM_NOTE });
  } catch (e) {
    // ignore DM failures
  }
}

let sieChannelId;

// event: new user joins workspace → invite to SIE
app.event("team_join", async ({ event, client, logger }) => {
  try {
    sieChannelId ||= await getChannelIdByName(client, SIE_CHANNEL_NAME);
    await ensureInvite(client, event.user.id, sieChannelId);
  } catch (err) { logger.error(err); }
});

// event: someone leaves SIE → re-invite + DM
app.event("member_left_channel", async ({ event, client, logger }) => {
  try {
    sieChannelId ||= await getChannelIdByName(client, SIE_CHANNEL_NAME);
    if (event.channel === sieChannelId) {
      await ensureInvite(client, event.user, sieChannelId);
    }
  } catch (err) { logger.error(err); }
});

// optional: observe joins (useful in logs)
app.event("member_joined_channel", async () => { /* no-op */ });

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("Slack app running");
})();
