# EffectMaster – Default relay server for the Web Editor

This is made to be deployed onto Cloudflare Workers. Works for free up to a certain threshold.
It utilizes [serverless WebSockets](https://developers.cloudflare.com/workers/examples/websockets/) combined with [Durable Objects](https://developers.cloudflare.com/durable-objects/)
to save the sessions.

To test the relay server locally, fork this repo and use `npx wrangler dev`.

Parts of this code have been made using Claude.
