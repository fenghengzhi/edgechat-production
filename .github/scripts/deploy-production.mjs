import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A PushSubscription is tied to the VAPID public key. Only create the key on
// the first deployment, together with the Worker version that will use it.
export function deployProduction(runWrangler) {
  const config = ["--config", "wrangler.production.json"];
  const names = JSON.parse(runWrangler(["secret", "list", ...config, "--format", "json"]));
  if (!Array.isArray(names) || !names.every(secret => typeof secret?.name === "string")) {
    throw new Error("Cannot verify existing Worker secrets");
  }
  const args = ["deploy", ...config, "--keep-vars", "--no-experimental-provision", "--no-experimental-auto-create"];
  if (names.some(secret => secret.name === "WEB_PUSH_VAPID_JWK")) {
    runWrangler(args);
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "edgechat-vapid-"));
  try {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const file = join(directory, "secrets.json");
    writeFileSync(file, JSON.stringify({
      WEB_PUSH_VAPID_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
    }), { mode: 0o600, flag: "wx" });
    runWrangler([...args, "--secrets-file", file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deployProduction(args => execFileSync("node_modules/.bin/wrangler", args, {
    encoding: "utf8",
    stdio: ["ignore", args[0] === "secret" ? "pipe" : "inherit", "inherit"],
  }));
}
