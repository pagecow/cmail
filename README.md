# Cmail

A Gmail client for **[ChatOSS](https://chatoss.ai)** — read, send, star, archive, and trash mail from your own Google account, right inside the OS.

<img src="icon.svg" width="64" alt="Cmail icon">

## Features

- **Your own Gmail account.** An OAuth desktop flow — no middleman server. The client secret and refresh token live in the OS keychain through ChatOSS `secrets`, never in a file.
- **Full inbox.** Threaded conversation list, unread styling, star / archive / trash / restore, mark as read, search, and paging through older mail.
- **“For you” — a feed of your best mail.** An AI pass ranks the newest mail and pulls the things worth seeing into one screen, learning from what you open, star and reply to. Read mail stays on the feed, and the **All / Unread** toggle filters it.
- **Three ways to look at it.** **Tiles** that wrap in rows, **rows** that give each mail the full width, and **columns** that give each one the full height and scroll sideways. Your choice is remembered.
- **Read the mail on the card.** “See full email” opens the whole message inside the card — **rendered as a mail**: paragraphs with air between them, bullets for lists, inline images left out, and the quoted history dimmed behind a bar and collapsed behind a “…” pill until you ask for it. It stays open across refreshes, and clicks while reading never send you somewhere else.
- **Compose, reply, forward.** Replies open **empty** (the point is to write your own message) with proper `In-Reply-To` / `References` / `threadId` headers so they thread correctly; forwards carry the original text. Sending with no text asks first.
- **Labels.** Create labels with Gmail's colour palette, and apply or remove them on a conversation.
- **Attachments.** Click an attachment card to save the file into your ChatOSS Drive (`Attachments/…`).
- **Check for updates.** In **Settings** (like Term Coder's): compares this build with the repo's latest release and opens the release page when a newer version is out. ChatOSS also shows its own **Check for updates** in the window titlebar when the app is installed from its repo.
- **Keyboard shortcuts.** Gmail-style: `c` compose, `r` reply, `f` forward, `l` labels, `/` search, `j`/`k` move, `e` archive, `#` trash, `u` back, `Esc` close.

## Install

1. Download **`app-v0.6.1.aip`** from the [latest release](../../releases/latest) (the `.zip` is the same archive).
2. Drop it onto the **Apps** app in ChatOSS — or use Create → Publish.
3. Open Cmail from your dock and follow the in-app setup to connect Gmail.

## Permissions

| Capability | Why it is needed |
| --- | --- |
| `hostHttp` | talk to `gmail.googleapis.com` / `oauth2.googleapis.com` (and `raw.githubusercontent.com` / `api.github.com` for the update check) |
| `secrets` | keep your OAuth client secret and refresh token in the OS keychain |
| `openExternal` | open Google's consent page in your browser during setup |
| `clipboardRead` / `clipboardWrite` | paste the redirect URL back in during setup, copy addresses out |
| `drive` | save attachments into your ChatOSS Drive |

## Development

Plain HTML/CSS/JavaScript with no build step and no dependencies:

```
app.json     manifest (capabilities, hosts, icon)
index.html   the app shell
main.js      Gmail/OAuth core + the Gmail-shaped UI (list, thread, compose)
feed.js      “For you”: ranking, the feed database, the three layouts
style.css    layout, built on ChatOSS theme tokens
icon.svg     dock icon
```

Open the folder with ChatOSS **Create** for a live preview, or zip the files above (at the zip root) into `cmail.aip` and install it.

---

Built with [ChatOSS.ai](https://chatoss.ai).
