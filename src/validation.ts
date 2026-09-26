export type KeyBundle = {
  identityKey: string;
  signedPrekey: string;
  oneTimePrekeys: string[];
};

export function isKeyBundle(value: unknown): value is KeyBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const bundle = value as Record<string, unknown>;
  return (
    typeof bundle.identityKey === "string" &&
    bundle.identityKey.length > 0 &&
    typeof bundle.signedPrekey === "string" &&
    bundle.signedPrekey.length > 0 &&
    Array.isArray(bundle.oneTimePrekeys) &&
    bundle.oneTimePrekeys.every((key) => typeof key === "string" && key.length > 0)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}