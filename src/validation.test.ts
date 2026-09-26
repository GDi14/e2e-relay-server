import assert from "node:assert/strict";
import test from "node:test";
import { isKeyBundle, isUuid } from "./validation.js";

test("accepts key material as opaque non-empty strings", () => {
  assert.equal(
    isKeyBundle({
      identityKey: "opaque-identity-blob",
      signedPrekey: "opaque-signed-prekey-blob",
      oneTimePrekeys: ["opaque-one-time-prekey"],
    }),
    true,
  );
});

test("rejects incomplete bundle structure without examining blob content", () => {
  assert.equal(isKeyBundle({ identityKey: "blob", signedPrekey: "blob", oneTimePrekeys: [1] }), false);
  assert.equal(isKeyBundle(null), false);
});

test("accepts UUID identifiers and rejects non-UUID routing values", () => {
  assert.equal(isUuid("a2c5ac6c-1d25-4c3e-9b83-4607e24726ab"), true);
  assert.equal(isUuid("someone@example.com"), false);
});