# E2E Relay Server

A TypeScript relay for an end-to-end encrypted messenger. Ciphertext and key bundle fields are opaque strings; the server does not decrypt, inspect, index, or log their contents. WebSocket connections carry routing envelopes, and Postgres retains each message until the recipient acknowledges it. Delivery is at-least-once, so clients should deduplicate by `messageId`.

## Run

Set the environment variables below, then run `npm ci`, `npm run build`, and `npm start`. The container listens on `PORT`, which Railway supplies. `GET /health` returns `200` without authentication.

On startup, the service creates its tables and inserts hashes of the configured invite codes. Codes are single-use. Changing `INVITE_CODES` activates the configured list and deactivates codes removed from it; consumed codes remain consumed if re-added.

## API

- `POST /v1/register`: JSON `{ "displayName": "...", "inviteCode": "...", "keyBundle": { "identityKey": "base64", "signedPrekey": "base64", "oneTimePrekeys": ["base64"] } }`. Returns `201` with `{ "userId": "..." }`. Invalid or consumed codes return `400`.
- `GET /v1/users/:userId/keys`: returns the current registered public key bundle.
- `PUT /v1/users/:userId/keys`: replaces the stored public key bundle using the same `keyBundle` object shape.
- WebSocket `/v1/relay?userId=<uuid>`: send `{ "type": "send", "recipientId": "<uuid>", "ciphertext": "<opaque-base64>", "metadata": {} }`. The server replies with `accepted`; recipients receive a `message` envelope and acknowledge it using `{ "type": "ack", "messageId": "<uuid>" }`. Messages remain queued until acknowledged.
- `POST /v1/media/upload-url`: returns a random `mediaId` and presigned PUT URL.
- `GET /v1/media/:mediaId/download-url`: returns a presigned GET URL.

## Environment

- `PORT` (required): TCP port to listen on; supplied by Railway.
- `DATABASE_URL` (required): PostgreSQL connection string.
- `INVITE_CODES` (required): comma-separated initial invite codes. Codes are hashed before storage.
 `S3_ENDPOINT` (required for media URLs): S3-compatible endpoint, such as the Cloudflare R2 account endpoint. Media configuration is lazy and does not prevent relay startup.
 `S3_REGION` (required for media URLs): storage region (`auto` for Cloudflare R2).
 `S3_BUCKET` (required for media URLs): bucket for encrypted media.
 `S3_ACCESS_KEY_ID` (required for media URLs): S3-compatible access key.
 `S3_SECRET_ACCESS_KEY` (required for media URLs): S3-compatible secret key.

Only `PORT`, `DATABASE_URL`, and `INVITE_CODES` are required for startup. If storage configuration is incomplete, the server stays online and media URL endpoints return `503` until all five `S3_*` settings are supplied. If startup fails, Railway logs identify the failing stage and a sanitized error code without printing credentials or message/key contents.

## Deployment and limitations

Build with `docker build -t e2e-relay-server .` and provide the same environment variables to the container. Configure the bucket and credentials outside the image.

There is intentionally no login or authenticated session layer: the WebSocket `userId` is a client claim, not proof of identity. Consequently, this is suitable only behind a separately trusted network boundary or for a prototype; unauthenticated callers can claim IDs, replace key bundles, read bundles, and request media URLs. Invite codes are only used during registration. One-time prekeys are distributed as the stored bundle and are not individually claimed or depleted. Media object existence and per-user access controls are not tracked. Add an authenticated session protocol and one-time-prekey claim/rotation before exposing this service to untrusted clients.