"""Apply this installation's bindings to the upstream Worker configuration."""

import json
import os
import re
import tomllib
from pathlib import Path


with Path("wrangler.example.toml").open("rb") as source:
    config = tomllib.load(source)

config["name"] = "edgechat"
config["workers_dev"] = True
# Cloudflare already serves this Worker at chat.fenghengzhi.com. Leaving the
# domain under dashboard management avoids a zone-level permission in CI.
if "routes" in config or "route" in config:
    raise ValueError("Review new upstream routes before updating this installation")


def binding(section, name):
    entries = config[section]
    if len(entries) != 1 or entries[0]["binding"] != name:
        raise ValueError(f"Review upstream changes to {section} before deploying")
    return entries[0]


binding("d1_databases", "DB").update(
    database_name="web-chat-app-directory",
    database_id="b7659035-33eb-4889-895e-ed69a87f3903",
)
binding("kv_namespaces", "SESSIONS")["id"] = "6448927aeda7475688fff65655f61cd5"
binding("r2_buckets", "FILES")["bucket_name"] = "web-chat-app-media"

variables = config["vars"]
variables["ADMIN_USERNAMES"] = "fenghengzhi"
variables["SITE_ORIGINS"] = "https://edgechat.fenghengzhi.workers.dev,https://chat.fenghengzhi.com"
retention = os.getenv("MESSAGE_RETENTION_DAYS", "30")
if not re.fullmatch(r"[1-9][0-9]*", retention):
    raise ValueError("MESSAGE_RETENTION_DAYS must be a positive integer")
variables["MESSAGE_RETENTION_DAYS"] = retention
additional_types = (
    "application/zip", "application/x-zip-compressed", "application/x-7z-compressed",
    "application/gzip", "application/x-tar", "application/vnd.openxmlformats-officedocument.",
    "application/vnd.oasis.opendocument.", "application/msword", "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
)
variables["ALLOWED_FILE_TYPES"] = ",".join(dict.fromkeys([
    *variables["ALLOWED_FILE_TYPES"].split(","), *additional_types,
]))

print(json.dumps(config, indent=2))
