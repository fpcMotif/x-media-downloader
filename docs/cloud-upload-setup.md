# Cloud Upload setup — Google Drive & Dropbox

How to connect the extension's **Cloud upload** feature (ADR-0013) so it uploads
the real media **bytes** (photos + video) to your own Google Drive and Dropbox.

The extension uses **client-side OAuth with PKCE** — bytes go from the extension
straight to the provider, never through any server of ours. You provide your own
OAuth app credentials; there are **no secrets in the bundle** (PKCE replaces the
client secret), and the client ID / app key are public values, safe to paste.

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
   - Create it, then copy the **Client ID** (looks like `xxxx.apps.googleusercontent.com`).
     (A client secret is also issued — you do **not** need it; PKCE is used.)
5. In the popup, paste the Client ID into **Google Drive → OAuth client ID** and
   click **Connect**. Approve the consent screen.

Files land in a per-handle subfolder under a **"X Media Downloader"** folder in
your Drive.

> **Scope note.** This uses the full-Drive scope (a *sensitive* scope). For
> personal use as a registered test user it works immediately. A **public**
> Chrome Web Store release would require Google OAuth verification (and likely a
> CASA security assessment). To avoid that, change `GDRIVE_OAUTH.scope` in
> [`src/core/cloud/types.ts`](../src/core/cloud/types.ts) to
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
OAuth flow. Do **not** put any client *secret* here — none is used.

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
  cross-device visibility — **never the bytes**.
- **Disconnect** clears that provider's stored tokens. Already-uploaded files are
  not removed.

See [ADR-0013](adr/0013-client-side-cloud-byte-upload.md) for the full design.
