# Mail Tracker

Self-hosted open and click tracking for Gmail. It's a personal alternative to tools like Snov.io's Unlimited Email Tracker, except the data stays on your own server.

Sent emails get status labels right inside Gmail:

| Label | Meaning |
|---|---|
| ⏱ **Unopened** (grey) | Nobody has opened the email yet |
| 👁 **Opened** (purple) | The email was opened. A badge shows the count when there's more than one open |
| ↖ **Clicked** (green) | A link in the email was clicked |

Hover over a label for a card with open and click counts, when the email was last opened, and a timeline of each event with the mail app and country. The toolbar popup lists every tracked email with your open rate and click rate.

---

## Contents

- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Setup](#setup)
  - [1. Deploy the server](#1-deploy-the-server-cloudflare-free-tier)
  - [2. Install the Chrome extension](#2-install-the-chrome-extension)
  - [3. Test it](#3-test-it)
- [Daily use](#daily-use)
- [Server API](#server-api)
- [Data and privacy](#data-and-privacy)
- [Accuracy and limits](#accuracy-and-limits)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## How it works

```
 Gmail (Chrome + extension)              Cloudflare Worker + D1               Recipient
 ─────────────────────────               ──────────────────────               ─────────
 compose  → adds 1×1 image  /p/<id>.gif
          → rewrites links  /c/<id>?u=…&s=…
 Send ─────────────────────────────────────────────────────────────────────→  inbox
                                          ← GET /p/<id>.gif  (open)  ───────  opens email
                                          ← GET /c/<id>…     (click) ───────  clicks link
                                             302 → original URL ───────────→
 every 30 s: POST /api/stats ───────────→ counts per email
          ← { opens, clicks, recent… }
 draws labels in Sent list + threads
```

- **While you write an email**, the extension adds an invisible 1×1 image and points each link at your server. Gmail saves its copy of the draft *before* any Send-button code can run, so the tracking has to be in place while you write; that way it's already in the draft Gmail sends.
- **Links are signed.** Each tracked link carries an HMAC-SHA256 signature made with your secret. A link that has been tampered with gets a "Continue to …" page instead of an automatic redirect, so nobody can use your server to bounce people to other sites.
- **Your own views don't count.** Whenever your browser loads one of your own tracking images (while composing, or when you look at a sent email), the extension tells the server, and any open within 15 seconds of that is ignored. Clicking your own tracked links in Gmail goes straight to the destination.
- **One view, one open.** If the same email's image loads several times within 2 minutes (Gmail redrawing the message, or a quick reopen), it counts as one open.

## Project layout

```
mail-tracker/
├── worker/                  Cloudflare Worker (server)
│   ├── src/index.js         Tracking image, click redirect, stats API
│   ├── schema.sql           D1 tables: events, self_views
│   ├── wrangler.toml        Worker + D1 binding config
│   ├── package.json         npm scripts: dev / deploy / db:init
│   └── .dev.vars.example    Local dev secret template
└── extension/               Chrome extension (Manifest V3)
    ├── manifest.json
    ├── content.js           Gmail integration: tracking, labels, hover card, compose toggle
    ├── content.css          Gmail UI styles
    ├── hmac.js              Synchronous HMAC-SHA256 for signing links
    ├── background.js        Talks to the server (stats, self views, health check)
    ├── popup.html / .js     Toolbar dashboard
    └── options.html / .js   Settings page
```

## Setup

You need a Mac or PC with **Node.js 18+**, **Google Chrome** and a free **Cloudflare account** (https://dash.cloudflare.com/sign-up).

### 1. Deploy the server (Cloudflare free tier)

```bash
cd worker
npm install
npx wrangler login                       # opens a browser; click Allow
npx wrangler d1 create mail-tracker      # prints a database_id
```

Paste the printed `database_id` into `worker/wrangler.toml`:

```toml
database_id = "1a2b3c4d-…"
```

Create the tables:

```bash
npm run db:init
```

Generate a secret and save it somewhere safe (a password manager is ideal):

```bash
openssl rand -hex 32
```

Store it on the server. Type the name **`TRACKER_SECRET` exactly**, then paste your secret when it asks for the value:

```bash
npx wrangler secret put TRACKER_SECRET
```

Deploy:

```bash
npm run deploy
```

This prints your server URL, for example `https://mail-tracker.<you>.workers.dev`. Open it in a browser and you should see **`mail-tracker is running`**.

### 2. Install the Chrome extension

1. Go to `chrome://extensions` and turn on **Developer mode** (top-right).
2. Click **Load unpacked** and choose the `extension/` folder.
3. Pin **Mail Tracker** from the puzzle-piece menu.
4. Right-click the icon → **Options**:
   - **Tracker URL:** your server URL from step 1
   - **Secret:** the same secret
   - Click **Test connection**. It should say **Connected**. Then click **Save**.
5. Reload Gmail.

> **Run only one email tracker.** Turn off Snov.io, Mailtrack, Mailsuite and similar extensions. They replace each other's tracking images.

### 3. Test it

1. Compose an email to another account you own. A purple **Tracking** chip appears next to Send.
2. Add a real link: select some text, press ⌘K / Ctrl+K and paste a URL. Then send it.
3. Optional check: in Sent, open the email → **⋮ → Show original** and search for `workers.dev`. The image and the link should both point at your server.
4. Open the email **on another device or in another browser.** Opens in the Chrome profile that has the extension are treated as yours and never counted.
5. Within about 30 seconds the label in Sent changes to **Opened**. Clicking the link adds **Clicked**.

## Daily use

- **Turn tracking off for one email:** click the **Tracking** chip next to Send. It changes to **Not tracking**.
- **Turn tracking off by default:** go to Options and switch off **Track new emails by default**.
- **Activity details:** hover over any label in Gmail.
- **Overview:** click the toolbar icon. The tabs filter by All / Opened / Unopened / Clicked, and clicking an email searches for it in Gmail.
- **Clear history in this browser:** Options → **Clear tracked-email list**.
- **Clear history on the server:**
  ```bash
  cd worker
  npx wrangler d1 execute mail-tracker --remote --command "DELETE FROM events; DELETE FROM self_views;"
  ```

## Server API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /` | none | Health text: `mail-tracker is running` |
| `GET /p/:id.gif` | none | Tracking image. Logs an `open` and returns a 1×1 GIF, never cached |
| `GET /c/:id?u=<url>&s=<sig>` | signature | Logs a `click` and sends a 302 redirect to `u`. A bad signature gets a "Continue" page instead |
| `GET /api/health` | Bearer | Checks the secret |
| `POST /api/stats` `{ids:[…]}` | Bearer | Per email: `{opens, clicks, firstOpen, lastOpen, lastClick, recent[]}` (up to 100 ids) |
| `POST /api/self` `{ids:[…]}` | Bearer | "The sender is viewing these now" |

`Bearer` means the header `Authorization: Bearer <TRACKER_SECRET>`. The signature is `s = HMAC_SHA256(secret, "<id>|<url>")`, the first 16 hex characters.

Tuning constants are at the top of `worker/src/index.js`:

| Constant | Default | Meaning |
|---|---|---|
| `SELF_WINDOW_MS` | 15 s | Opens this close to one of your own views are ignored |
| `OPEN_DEDUPE_MS` | 2 min | Repeat loads within this window count as one open |

## Data and privacy

- **On the server (D1):** for each open or click it stores the email id, the timestamp, the user-agent string (cut to 300 characters), the country, and for clicks the destination URL. It stores **no** IP addresses, email content, subjects or recipients.
- **In the browser (`chrome.storage.local`):** the subject, recipients and send time of each tracked email. This list stays in this browser and isn't synced. The URL and secret are kept in `chrome.storage.sync`.
- Email tracking is legal in most places, but some regions and organisations expect you to disclose it. Use it responsibly.

## Accuracy and limits

- **Opens are approximate. This is true of every image-based tracker.**
  - Apple Mail Privacy Protection loads images automatically, so an email can show as opened when nobody read it.
  - Mail apps that block images never register an open, though a click still registers.
  - Corporate or school security scanners can create extra opens.
- Gmail's image proxy caches images, so a later reopen by the same person might not be counted.
- Only links that are real `<a>` links at send time are tracked. Links in quoted text are left alone.
- Plain-text mode and **Schedule send** aren't supported. Emails sent from the Gmail phone app aren't tracked.
- The Sent list is matched to tracked emails by Gmail thread ID. When there isn't one, it matches by subject and time, and only in the Sent folder.
- The extension relies on Gmail's page structure. If Gmail changes it, update the selectors at the top of `extension/content.js`:

  | Selector | What it finds |
  |---|---|
  | `div[role="button"].aoO` | Send button |
  | `div[contenteditable][role="textbox"]` | Compose body |
  | `input[name="subjectbox"]` | Subject field |
  | `tr.zA`, `.y6`, `.bog`, `.xW [title]` | Mail list rows, subject, date |
  | `.adn`, `.gH`, `.a3s` | Messages in an open thread, their header and body |
  | `h2[data-legacy-thread-id]` | Thread ID |

## Troubleshooting

| Problem | What to do |
|---|---|
| The server URL says `TRACKER_SECRET is not set` | The secret was saved under the wrong name. Run `npx wrangler secret list`. If the listed name is a long hex string, delete it with `npx wrangler secret delete <name>` and run `npx wrangler secret put TRACKER_SECRET` again |
| **Test connection** says it isn't set | The URL box is empty. The grey text is only a placeholder. Type your URL |
| **Test connection** says *Wrong secret* | The secret in Options doesn't match the server's. Copy it again, or set a new one on both sides |
| Show original has no `workers.dev` | Another tracker extension is replacing the image. Disable it, quit Chrome completely (⌘Q) and try again |
| The label stays **Unopened** | Open the email on another device. Check that images are shown in the recipient's mail app. Reload Gmail |
| One email appears twice | Reload the extension, then Options → **Clear tracked-email list** |
| No labels at all | Reload the extension on `chrome://extensions`, then reload Gmail. Check the Gmail tab's console (⌘⌥J) for `[mail-tracker]` errors |

To see what the server has logged:

```bash
cd worker
npx wrangler d1 execute mail-tracker --remote --command \
  "SELECT email_id, type, datetime(ts/1000,'unixepoch') AS t, substr(ua,1,60) AS ua FROM events ORDER BY ts DESC LIMIT 20;"
```

## Development

Run the server locally:

```bash
cd worker
cp .dev.vars.example .dev.vars        # sets TRACKER_SECRET for local dev
npm run db:init:local
npm run dev                           # http://localhost:8787
```

Extension changes: edit the files in `extension/`, click **↻** on `chrome://extensions`, then reload Gmail. Gmail enforces Trusted Types, so the content script builds all its UI with DOM APIs and never uses `innerHTML`.

Server changes: `cd worker && npm run deploy`. Secrets and data carry over between deploys.
