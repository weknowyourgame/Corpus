# DataStore / Open Cloud — Safe Local Validation Guide

Use this guide to exercise the DataStore tools end-to-end **without touching production data**. Everything below assumes a throwaway place created for this purpose.

> **Do not** point `ROBLOX_UNIVERSE_ID` at a live production universe while validating. Use a sandbox universe with no real player data.

## 1. Prepare a sandbox universe

1. In Studio, create or open a brand-new place. Publish it as a private experience named e.g. `Stud DataStore Sandbox`.
2. Note the **Universe ID** (Creator Dashboard → Game → `…` → Copy Universe ID).
3. In **Game Settings → Security**, enable **Studio Access to API Services**.
4. Inside the place, create a `Script` in `ServerScriptService` that seeds the test store:
   ```lua
   local DataStoreService = game:GetService("DataStoreService")
   local store = DataStoreService:GetDataStore("StudSandbox")
   store:SetAsync("hello", "world")
   store:SetAsync("counter", 0)
   print("seeded StudSandbox")
   ```
5. Play-solo once so the writes flush. Stop playtest. The keys `hello` and `counter` now exist in the sandbox.

## 2. Issue an Open Cloud key scoped to the sandbox

1. Creator Dashboard → **API Keys** → **Create API Key**.
2. **Access permissions:** `universe-datastores.objects` → `read`, `write`, `delete`, `update`. Restrict the operations you do not plan to validate.
3. **Universes:** add **only** the sandbox universe. Do not add production universes.
4. **IP allowlist:** add `0.0.0.0/0` only if you cannot pin your local IP. Prefer a single `/32` for your workstation.
5. Save and copy the key **once**.

## 3. Configure the bridge

Add the two values to your local `.env` next to the rest of the bridge config:

```bash
ROBLOX_OPEN_CLOUD_API_KEY=…paste sandbox key…
ROBLOX_UNIVERSE_ID=…sandbox universe id…
```

These are only read by `server/index.js` and never surfaced to the React app or the Studio plugin. Restart the bridge:

```bash
npm run dev:bridge
```

If the values are missing you will see:

> `[Stud Bridge] Open Cloud DataStore tools are disabled. Set ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_UNIVERSE_ID in .env to enable.`

…and every DataStore tool will return `{ code: "open_cloud_not_configured" }` until the bridge is restarted with the keys set.

## 4. Walk through every operation

Open the chat UI and run the prompts below in sequence. The list at the top of the approval card must read `universe = <sandbox id>` for every mutation — abort if anything else appears.

### 4.1 List stores (read, no approval)

> `List my DataStore names.`

Expect a `roblox_datastore__list_stores` call returning at least `["StudSandbox"]`.

### 4.2 Read a key (read, no approval)

> `Read the key "hello" from StudSandbox.`

Expect `value: "world"`, `bytes: 5`, no approval prompt.

### 4.3 Approve a development write (single approval)

> `Write the value "alpha" to key "hello" in StudSandbox. Use environment=development.`

The approval card must show:

* Operation `WRITE`, env badge `DEVELOPMENT`
* Universe = sandbox id, store `StudSandbox`, scope `global`, key `hello`
* Old value `world`, new value `alpha`
* Rollback note: studio version history ~30 days

Press **Allow once**. Result must include `ok: true, version: <new>`. The card must close on the first decision (no double prompt).

### 4.4 Deny a write

> `Now write "beta" to key "hello".`

When the card appears, press **Deny**. Tool result must be `{ denied: true, … }`. Confirm via `roblox_datastore__read_key` that the key is still `alpha`.

### 4.5 Delete (requires approval)

> `Delete key "hello" from StudSandbox in development.`

Approve. Re-read the key and confirm `value: null`.

### 4.6 Increment (requires approval)

> `Increment key "counter" in StudSandbox by 5 in development.`

Approve. Result returns the new numeric value. Re-read and confirm.

### 4.7 Elevated production confirmation

> `Write the value "live" to key "hello" in StudSandbox with environment=production.`

The approval card must:

* Show a **red** `PRODUCTION` badge.
* Show the destructive shield icon and "PRODUCTION approval required".
* Replace the primary button with **Allow once (PRODUCTION)** styled as destructive.

For this sandbox validation **press Deny**. We are confirming the elevated UI works; we never validate prod against real prod data.

## 5. Verify nothing leaks

After the run, in another terminal:

```bash
grep -F "$ROBLOX_OPEN_CLOUD_API_KEY" $(ls -1 ~/.stud/conversations/*/events.jsonl 2>/dev/null) 2>/dev/null && echo "LEAK" || echo "ok"
```

(Adapt the path to wherever the conversation store persists; the in-memory store keeps nothing on disk.) The grep must report `ok`.

Then inspect the chat's event stream payloads from the browser devtools network tab and confirm no event of type `tool_call`, `approval_pending`, `tool_result`, or `approval_resolved` contains either the API key or the raw `value` you wrote when it was over 500 bytes.

## 6. Tear down

1. Revoke the Open Cloud key from the Creator Dashboard.
2. Remove `ROBLOX_OPEN_CLOUD_API_KEY` and `ROBLOX_UNIVERSE_ID` from `.env`.
3. Restart the bridge and confirm the disabled-warning line returns.

Only after these three steps is the sandbox safe to leave alone.
