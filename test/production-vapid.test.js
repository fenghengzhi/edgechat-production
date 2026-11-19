import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { deployProduction } from "../.github/scripts/deploy-production.mjs";

test("deploys with a private P-256 key on first use and removes the temporary secret on failure", () => {
  let file;
  assert.throws(() => deployProduction(args => {
    if (args[0] === "secret") return "[]";
    file = args[args.indexOf("--secrets-file") + 1];
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const { WEB_PUSH_VAPID_JWK } = JSON.parse(readFileSync(file));
    const key = createPrivateKey({ key: JSON.parse(WEB_PUSH_VAPID_JWK), format: "jwk" });
    assert.equal(key.asymmetricKeyDetails.namedCurve, "prime256v1");
    throw new Error("deployment interrupted");
  }), /deployment interrupted/);
  assert.equal(existsSync(file), false);
});

test("keeps the existing VAPID key and fails closed on ambiguous secret listings", () => {
  const commands = [];
  deployProduction(args => {
    commands.push(args);
    return JSON.stringify([{ name: "WEB_PUSH_VAPID_JWK" }]);
  });
  assert.deepEqual(commands.map(args => args[0]), ["secret", "deploy"]);
  assert.ok(!commands[1].includes("--secrets-file"));
  for (const listing of ['{}', '[{}]', 'not JSON']) {
    assert.throws(() => deployProduction(args => {
      assert.equal(args[0], "secret");
      return listing;
    }));
  }
});
