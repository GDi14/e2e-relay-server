import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Pool, type PoolClient } from "pg";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { isKeyBundle, isUuid, type KeyBundle } from "./validation.js";

type RelayMessage = {
  type: "message";
  messageId: string;
  senderId: string;
  recipientId: string;
  ciphertext: string;
  metadata: unknown;
  createdAt: string;
};

const requiredEnv = [
  "PORT",
  "DATABASE_URL",
  "INVITE_CODES",
] as const;

function requireEnvironment(): void {
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: message });
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invite_codes (
  code_hash TEXT PRIMARY KEY,
  is_active BOOLEAN NOT NULL DEFAULT true,
  consumed_at TIMESTAMPTZ,
  consumed_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS key_bundles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bundle JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS relay_messages (
  id UUID PRIMARY KEY,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relay_messages_recipient_created_idx
  ON relay_messages(recipient_id, created_at);
`;

const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const mediaUrlTtl = Number(process.env.MEDIA_URL_TTL_SECONDS ?? "900");
const sockets = new Map<string, Set<WebSocket>>();

function getMediaStorage(): { client: S3Client; bucket: string } | undefined {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    return undefined;
  }
  return {
    client: new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    }),
    bucket: S3_BUCKET,
  };
}

app.setErrorHandler((error: Error & { statusCode?: number }, _request: FastifyRequest, reply: FastifyReply) => {
  const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
  reply.code(status).send({ error: status === 500 ? "Internal server error" : "Invalid request" });
});

app.get("/health", async (_request, reply) => reply.code(200).send({ status: "ok" }));

app.post<{ Body: { displayName?: unknown; inviteCode?: unknown; keyBundle?: unknown } }>(
  "/v1/register",
  async (request, reply) => {
    const { displayName, inviteCode, keyBundle } = request.body ?? {};
    if (
      typeof displayName !== "string" ||
      displayName.trim().length === 0 ||
      displayName.length > 80 ||
      typeof inviteCode !== "string" ||
      inviteCode.length === 0 ||
      !isKeyBundle(keyBundle)
    ) {
      return badRequest(reply, "A display name, valid invite code, and key bundle are required");
    }

    const client = await pool.connect();
    const userId = randomUUID();
    const codeHash = createHash("sha256").update(inviteCode).digest("hex");
    try {
      await client.query("BEGIN");
      const invite = await client.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM invite_codes WHERE code_hash = $1 AND is_active = true FOR UPDATE",
        [codeHash],
      );
      if (invite.rowCount !== 1 || invite.rows[0].consumed_at !== null) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "Invalid or already used invite code" });
      }

      await client.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [userId, displayName.trim()]);
      await client.query("INSERT INTO key_bundles (user_id, bundle) VALUES ($1, $2::jsonb)", [userId, JSON.stringify(keyBundle)]);
      await client.query(
        "UPDATE invite_codes SET consumed_at = now(), consumed_by = $2 WHERE code_hash = $1",
        [codeHash, userId],
      );
      await client.query("COMMIT");
      return reply.code(201).send({ userId });
    } catch {
      await rollbackQuietly(client);
      return reply.code(500).send({ error: "Registration failed" });
    } finally {
      client.release();
    }
  },
);

app.get<{ Params: { userId: string } }>("/v1/users/:userId/keys", async (request, reply) => {
  if (!isUuid(request.params.userId)) return badRequest(reply, "Invalid user ID");
  try {
    const result = await pool.query<{ bundle: KeyBundle }>(
      "SELECT bundle FROM key_bundles WHERE user_id = $1",
      [request.params.userId],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "User not found" });
    return reply.send({ userId: request.params.userId, keyBundle: result.rows[0].bundle });
  } catch {
    return reply.code(500).send({ error: "Could not retrieve key bundle" });
  }
});

app.put<{ Params: { userId: string }; Body: unknown }>("/v1/users/:userId/keys", async (request, reply) => {
  if (!isUuid(request.params.userId)) return badRequest(reply, "Invalid user ID");
  if (!isKeyBundle(request.body)) return badRequest(reply, "A valid key bundle is required");
  try {
    const result = await pool.query(
      "UPDATE key_bundles SET bundle = $2::jsonb, updated_at = now() WHERE user_id = $1",
      [request.params.userId, JSON.stringify(request.body)],
    );
    if (result.rowCount === 0) return reply.code(404).send({ error: "User not found" });
    return reply.code(204).send();
  } catch {
    return reply.code(500).send({ error: "Could not update key bundle" });
  }
});

app.post("/v1/media/upload-url", async (_request, reply) => {
  const storage = getMediaStorage();
  if (!storage) return reply.code(503).send({ error: "Media storage is not configured" });
  const mediaId = randomUUID();
  try {
    const url = await getSignedUrl(storage.client, new PutObjectCommand({ Bucket: storage.bucket, Key: mediaId }), {
      expiresIn: mediaUrlTtl,
    });
    return reply.code(201).send({ mediaId, url, expiresIn: mediaUrlTtl });
  } catch {
    return reply.code(503).send({ error: "Media storage is unavailable" });
  } finally {
    storage.client.destroy();
  }
});

app.get<{ Params: { mediaId: string } }>("/v1/media/:mediaId/download-url", async (request, reply) => {
  if (!isUuid(request.params.mediaId)) return badRequest(reply, "Invalid media ID");
  const storage = getMediaStorage();
  if (!storage) return reply.code(503).send({ error: "Media storage is not configured" });
  try {
    const url = await getSignedUrl(storage.client, new GetObjectCommand({ Bucket: storage.bucket, Key: request.params.mediaId }), {
      expiresIn: mediaUrlTtl,
    });
    return reply.send({ url, expiresIn: mediaUrlTtl });
  } catch {
    return reply.code(503).send({ error: "Media storage is unavailable" });
  } finally {
    storage.client.destroy();
  }
});

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The connection will be released even if the transaction is already gone.
  }
}

async function addInviteCodes(): Promise<void> {
  const codes = (process.env.INVITE_CODES ?? "").split(",").map((code) => code.trim()).filter(Boolean);
  if (codes.length === 0) throw new Error("INVITE_CODES must contain at least one code");
  const hashes = codes.map((code) => createHash("sha256").update(code).digest("hex"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE invite_codes SET is_active = false");
    for (const codeHash of hashes) {
      await client.query(
        "INSERT INTO invite_codes (code_hash, is_active) VALUES ($1, true) ON CONFLICT (code_hash) DO UPDATE SET is_active = true",
        [codeHash],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function deliverQueued(userId: string, socket: WebSocket): Promise<void> {
  const result = await pool.query<{
    id: string;
    sender_id: string;
    recipient_id: string;
    ciphertext: string;
    metadata: unknown;
    created_at: Date;
  }>(
    "SELECT id, sender_id, recipient_id, ciphertext, metadata, created_at FROM relay_messages WHERE recipient_id = $1 ORDER BY created_at",
    [userId],
  );
  for (const row of result.rows) {
    if (socket.readyState !== WebSocket.OPEN) return;
    sendMessage(socket, {
      type: "message",
      messageId: row.id,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      ciphertext: row.ciphertext,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    });
  }
}

function sendMessage(socket: WebSocket, message: RelayMessage): void {
  socket.send(JSON.stringify(message));
}

async function handleSocketMessage(userId: string, socket: WebSocket, raw: Buffer): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(raw.toString("utf8"));
  } catch {
    socket.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
    return;
  }
  if (!isRecord(input) || typeof input.type !== "string") {
    socket.send(JSON.stringify({ type: "error", error: "Invalid message" }));
    return;
  }

  if (input.type === "ack") {
    if (!isUuid(input.messageId)) {
      socket.send(JSON.stringify({ type: "error", error: "Invalid message ID" }));
      return;
    }
    try {
      await pool.query("DELETE FROM relay_messages WHERE id = $1 AND recipient_id = $2", [input.messageId, userId]);
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Acknowledgement failed" }));
    }
    return;
  }

  if (
    input.type !== "send" ||
    !isUuid(input.recipientId) ||
    typeof input.ciphertext !== "string" ||
    input.ciphertext.length === 0
  ) {
    socket.send(JSON.stringify({ type: "error", error: "Invalid relay envelope" }));
    return;
  }
  const metadata = input.metadata ?? {};
  const messageId = randomUUID();
  try {
    const recipient = await pool.query("SELECT 1 FROM users WHERE id = $1", [input.recipientId]);
    if (recipient.rowCount === 0) {
      socket.send(JSON.stringify({ type: "error", error: "Recipient not found" }));
      return;
    }
    await pool.query(
      "INSERT INTO relay_messages (id, sender_id, recipient_id, ciphertext, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [messageId, userId, input.recipientId, input.ciphertext, JSON.stringify(metadata)],
    );
    const relay: RelayMessage = {
      type: "message",
      messageId,
      senderId: userId,
      recipientId: input.recipientId,
      ciphertext: input.ciphertext,
      metadata,
      createdAt: new Date().toISOString(),
    };
    for (const target of sockets.get(input.recipientId) ?? []) {
      if (target.readyState === WebSocket.OPEN) sendMessage(target, relay);
    }
    socket.send(JSON.stringify({ type: "accepted", messageId }));
  } catch {
    socket.send(JSON.stringify({ type: "error", error: "Message relay failed" }));
  }
}

async function start(): Promise<void> {
  requireEnvironment();
  if (!Number.isInteger(mediaUrlTtl) || mediaUrlTtl < 1 || mediaUrlTtl > 604800) {
    throw new Error("MEDIA_URL_TTL_SECONDS must be an integer between 1 and 604800");
  }
  startupStage = "database-schema";
  await pool.query(schema);
  startupStage = "invite-code-sync";
  await addInviteCodes();
  startupStage = "http-listen";
  await app.listen({ port: Number(process.env.PORT), host: "0.0.0.0" });

  const websocketServer = new WebSocketServer({ server: app.server, path: "/v1/relay", maxPayload: 1_048_576 });
  websocketServer.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const userId = url.searchParams.get("userId");
    if (!isUuid(userId)) {
      socket.close(1008, "Valid userId is required");
      return;
    }

    const connected = sockets.get(userId) ?? new Set<WebSocket>();
    connected.add(socket);
    sockets.set(userId, connected);
    void deliverQueued(userId, socket).catch(() => socket.close(1011, "Queue unavailable"));

    socket.on("message", (raw) => {
      void handleSocketMessage(userId, socket, toBuffer(raw));
    });
    socket.on("close", () => {
      connected.delete(socket);
      if (connected.size === 0) sockets.delete(userId);
    });
  });
}

function safeStartupError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("Missing required environment variables:")) {
    return error.message;
  }
  if (error instanceof Error && error.message === "PORT must be an integer between 1 and 65535") {
    return error.message;
  }
  if (error instanceof Error && error.message === "INVITE_CODES must contain at least one code") {
    return error.message;
  }
  if (error instanceof Error && error.message === "MEDIA_URL_TTL_SECONDS must be an integer between 1 and 604800") {
    return error.message;
  }
  const code = isRecord(error) && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(error.code)
    ? error.code
    : undefined;
  return code ? `error_code=${code}` : "error_code=unavailable";
}

let startupStage = "configuration";
start().catch((error: unknown) => {
  process.stderr.write(`Relay startup failed at stage=${startupStage}: ${safeStartupError(error)}\n`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().finally(async () => {
      await pool.end();
    });
  });
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}