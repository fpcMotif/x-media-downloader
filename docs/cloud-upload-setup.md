# Cloud Upload setup — Google Drive & Dropbox

How to connect the extension's **Cloud upload** feature (ADR-0013) so it uploads
the real media **bytes** (photos + video) to your own Google Drive and Dropbox.

## At a glance

Browser cloud uploads use your connection, and closing the browser interrupts that path.
The default remains browser upload; a separate opt-in experiment relays Cloud-only Drive media through your own Convex deployment.
Local downloads, Dropbox, and metadata mirroring retain their existing behavior.

Browser OAuth uses PKCE, but Google's Web application client also requires a user-supplied client secret.
No private credentials ship in the bundle.
The server experiment requires separately provisioned deployment credentials; it never copies extension secrets.

---

## 0. Get your redirect URL (needed by both providers)

Open the popup → enable **Cloud upload**. The section shows a line:

> Register this redirect URL in the provider console: `https://<EXTENSION_ID>.chromiumapp.org/`

Copy that exact URL. You'll register it with both providers below.

> ⚠️ The `<EXTENSION_ID>` differs between an unpacked dev build and a published
> build. Either register both, or pin the id by adding a `key` to the manifest
> (see [Chrome docs: keep a consistent extension ID](https://developer.chrome.com/docs/extensions/reference/manifest/key)).

---

## 1. Google Drive

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create
   (or pick) a project.
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen:**
   - User type **External**. Fill in the app name + your email.
   - Add yourself under **Test users** (required while the app is unverified).
   - Add the scope `https://www.googleapis.com/auth/drive`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type **Web application**.
   - Under **Authorized redirect URIs**, add the redirect URL from step 0.
   - Create it, then copy **both** the **Client ID** (looks like
     `xxxx.apps.googleusercontent.com`) and the **Client secret** (`GOCSPX-…`).
5. In Options → Sync, paste the Client ID into **Google Drive → OAuth client ID**,
   paste the secret into **Client secret**, then click **Connect**. Approve the
   consent screen.

> **Why Google needs a secret and Dropbox does not.** PKCE is meant to replace the
> client secret for a public client. Google does not honour that for its *Web
> application* client type: the token endpoint answers
> `400 client_secret is missing` even when a valid `code_verifier` is sent. Its
> *Chrome Extension* client type avoids the secret but only serves
> `chrome.identity.getAuthToken`, which returns no refresh token and is
> Chrome-only — so uploads would stop after an hour. The secret is therefore
> required here, and it is stored in extension local storage, the same posture as
> `aria2Secret` and `convexSyncSecret`. OAuth sends it to Google's token endpoint, not to the Convex relay.
>
> Before a Web Store release, move the token exchange behind your own Convex
> deployment (ADR-0009) so the bundle ships no secret. Dropbox is unaffected — it
> implements PKCE correctly and receives no `client_secret` param at all.

Files follow the planned filename's directories under the **"X Media Downloader"** root in your Drive.

> **Scope note.** This uses the full-Drive scope (a *sensitive* scope). For
> personal use as a registered test user it works immediately. A **public**
> Chrome Web Store release would require Google OAuth verification (and likely a
> CASA security assessment). To avoid that, review the Google scope in
> [`src/packages/cloud/provider.ts`](../src/packages/cloud/provider.ts) before changing it to
> `https://www.googleapis.com/auth/drive.file` (non-sensitive, app-created files
> only) — a one-line change.
>
> **Token note.** While the consent screen is in *Testing* status, Google refresh
> tokens expire after **7 days** — publish the app to *Production* for long-lived
> tokens, or just reconnect weekly.

---

## 2. Dropbox

1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps) →
   **Create app**.
2. Choose **Scoped access**, access type **App folder** (least privilege — uploads
   land in `Apps/<YourApp>/`), and name the app.
3. **Permissions** tab → enable **`files.content.write`** (and
   **`account_info.read`** for the account label). Submit.
4. **Settings** tab → under **OAuth 2 → Redirect URIs**, add the redirect URL
   from step 0.
5. Copy the **App key** (Settings tab).
6. In the popup, paste it into **Dropbox → App key** and click **Connect**.
   Approve access.

> **50-user cap.** A new Dropbox app is in *Development* and can link a limited
> number of accounts until you apply for **Production** approval. Irrelevant for
> personal use; a gate before a public release.

---

## 3. (Optional) Pre-seed the client IDs for a dev build

Instead of pasting in the popup, you can drop the **public** client IDs into a
gitignored root `.env` (read at build time, like `WXT_CONVEX_URL`):

```dotenv
WXT_GDRIVE_CLIENT_ID=xxxx.apps.googleusercontent.com
WXT_DROPBOX_APP_KEY=your_dropbox_app_key
```

On first run the background fills any empty client-ID field from these (it never
overrides a value you've already entered). You still click **Connect** to run the
OAuth flow. Do **not** put private credentials in public `WXT_` variables.

---

## How it works

- When you download media (any download strategy), the extension also enqueues an
  **UploadJob** per connected provider and uploads the bytes in parallel.
- The byte source (twimg) is fetched through an SSRF allow-list; bytes are
  **streamed** to the provider (small files in one request, large video in
  256 KiB / 4 MiB-multiple chunks) so memory stays bounded for 500 MB videos.
- Uploads are tracked in a durable local ledger with retry + exponential backoff;
  a link that 403/410s is honestly marked **skipped**, never a fake "saved".
- If Cloud Sync (Convex) is also on, upload-job *status* is mirrored to Convex for
  cross-device visibility. This mirror never authorizes server byte execution.
- **Disconnect** clears that provider's stored tokens. Already-uploaded files are
  not removed.

## 4. Experimental Cloud-only Drive relay

This feature is default-off and currently lacks live provider evidence.
Use a personal test deployment and an isolated Drive folder, not a production library.

1. Identify the exact Convex deployment before deploying the backend changes.
2. Provision a Google OAuth client and refresh token explicitly for that deployment owner.
3. Create an isolated Drive test folder, such as `XMD issue-96 relay experiment`.
4. Set the following variables using the deployment dashboard or secure credential tooling.
5. Deploy the backend after reviewing its schema and function changes.
6. Configure the extension's Convex URL and matching sync secret, then grant that origin's permission.
7. In Options → Sync, select **Check deployment setup**.
8. Enable Cloud upload and Drive Upload, and pause Dropbox uploads if connected.
9. Enable **Use Convex for Cloud-only Drive uploads**. This also enables Download History and disables disk saving.

| Deployment variable | Purpose |
| --- | --- |
| `SYNC_SHARED_SECRET` | Required authentication for submission, control, probing, and status |
| `RELAY_ENABLED` | Set to `true` for acceptance and transfer; otherwise requests stop at their next boundary |
| `RELAY_DRIVE_CLIENT_ID` | Deployment owner's Google OAuth client |
| `RELAY_DRIVE_CLIENT_SECRET` | Private Google OAuth client secret |
| `RELAY_DRIVE_REFRESH_TOKEN` | Private offline Google authorization |
| `RELAY_DRIVE_FOLDER_ID` | Isolated destination root folder |
| `RELAY_MAX_BYTES` | Optional source cap; default 536870912, maximum 2147483648 bytes |
| `RELAY_MAX_ELAPSED_MS` | Optional total job lifetime; default 3600000, maximum 86400000 milliseconds |
| `RELAY_MAX_RETRIES` | Optional maximum failures; default 3, maximum 10 |

Never copy extension credentials automatically or put private values in command transcripts, screenshots, or committed files.
A setup check verifies deployment configuration and authentication, not a successful Drive transfer.
Missing configuration or host permission produces an unavailable reason, never a browser relay fallback.

### Ownership, controls, and recovery

The experiment supports Google Drive only and never starts a local save or browser upload for accepted server media.
Source-host and redirect checks apply on the server; browser cookies are never forwarded.
Filename directories are preserved under the configured test root.
Every remote candidate requires a positive size from a backend HEAD probe, without browser source requests.
Unknown sizes fail visibly before submission, even when ordinary size filters are disabled.
Remote daily usage commits with job acceptance; remote admission combines it with the local browser tally.
Ordinary downloads read retained local receipt accounting and never require a Convex budget query.
Duplicate submissions and worker retries never add another charge, including after an acceptance response is lost.
The accepted size also caps transfer bytes; a larger source fails instead of exceeding its reservation.
Transfer retries can consume additional bandwidth; daily usage counts accepted source bytes, not network billing.

Drive Upload pauses new admission; accepted jobs continue.
The master switch stops new requests at the next safe boundary, which may finish one in-flight chunk first.
Disconnect invalidates backend authorization for existing jobs, even after reconnecting.
It does not delete existing Drive files or automatically erase deployment secrets.
Revoke the deployment's Google grant separately if the credential itself must cease to exist.

Turning off the experiment preserves accepted job status and ownership.
Changing deployments requires disconnecting backend Drive first.
Receipts retain the original deployment and shared sync secret locally for authenticated status and budget queries.
Keep that origin's browser permission and shared secret valid; external secret rotation requires restoring its connection.
Confirmed rejection releases local ownership; an ambiguous submission remains reserved to avoid duplicate execution.
Download History remains queued until Drive confirms completion; server success never triggers disk Settle or Clear.

Each action transfers at most one 8 MiB chunk, with a 120-second local deadline.
The one-hour default covers the entire job, including retries and pauses; it is not one action's allowed runtime.
Large sources need valid ranges and a stable strong ETag.
Partial recovery also requires the original resolved URL and validator, even for small files.
Small non-ranged responses can complete within one chunk; unsafe larger responses fail explicitly.

See [ADR-0013](adr/0013-client-side-cloud-byte-upload.md) and the [experiment evidence](experiments/convex-drive-relay.md).
