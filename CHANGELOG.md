# Changelog

All notable changes are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

---

## [0.3.11] — 2026-09-19

### Fixed

- **Mistyping your current password logged you out.** 0.3.9 taught CloudGate
  to end a session when the server rejects it — but it read any rejection as
  "your session is over", and the server also rejects a wrong current password
  the same way. So a typo on the change-password form threw you back to the
  login screen instead of saying the password was wrong. CloudGate now
  distinguishes the two: only a problem with the session itself ends it. A
  wrong password, or a wrong second factor, just says so.
- An empty list and a failed one could appear at the same time, saying "nothing
  here yet" and "could not be loaded" side by side.

### Changed

- The container image labels were being written before the parts of the image
  that take the longest to build, so every release rebuilt and re-downloaded
  all of them from scratch. Moved to the end.

---

## [0.3.10] — 2026-09-19

### Changed

- **The container image now identifies itself.** Homelab app stores and
  container managers read a set of standard labels off an image to show a
  name, a short description, the licence and a link back to the source.
  CloudGate had none, so it appeared as a bare repository path. The image also
  carries its version, which means a pulled image can be identified without
  starting it.

---

## [0.3.9] — 2026-09-19

### Fixed

- **A restarting backend threw you back to the login screen.** Any failure to
  reach CloudGate was treated as "not signed in", so a restart, a brief
  outage, or a dropped connection looked exactly like a session ending — and
  you lost the page you were on for no reason. CloudGate now says it cannot
  reach the service, keeps your session, and offers a retry that puts you back
  where you were.
- **A list that failed to load looked like an empty one.** With the service
  unreachable, pages showed an empty card as though nothing were configured;
  when a background refresh failed, they kept showing the previous data as if
  it were current. Both now say what happened, with the error and a retry.
- **A dead session went unnoticed outside the main check.** Everything else
  kept failing quietly in the background. The first such response now ends the
  session properly.
- **A double-click on a delete button could hang the action.** The second
  prompt replaced the first, and whatever was waiting on the first never got
  an answer — so nothing happened at all, with no indication why.
- Cloudy's speech bubble no longer swallows clicks meant for the control he is
  standing next to. The support hint, which is meant to be clicked, still is.

### Changed

- **Every icon-only button now has a name** for screen readers and as a
  tooltip — 16 of them had none, including "delete host". The log view in the
  update dialog can be opened with the keyboard.

### Documentation

- The README and the architecture document both listed GPG signature
  verification as an active guarantee; it is not enabled yet, and now says so.
  The architecture document also still described `/__recovery/` in normal
  operation as a feature — the exposure removed in 0.3.2 — and the Cloudflare
  guide described an OAuth flow the software cannot perform.

---

## [0.3.8] — 2026-09-18

### Changed

- **Confirmation prompts are part of CloudGate now, instead of the browser's
  own.** Every "are you sure?" used to be the grey system box: it could not
  follow the app's appearance, it ignored your language and always said
  "OK"/"Cancel", and browsers suppress it after repeated use on one page —
  which quietly turns a question into a yes. The new dialogs name the action
  in their title, mark destructive ones in red, and treat Escape or a click
  outside as "no".
- Two prompts on the Tunnels page — re-synchronising and re-creating a tunnel
  — were still English regardless of the selected language. They explain what
  the operation actually does, which is the reason the prompt exists, so the
  explanation was translated rather than shortened.

---

## [0.3.7] — 2026-09-18

### Security — please read if you update from inside CloudGate

**Updating through the CloudGate interface cannot deliver every fix, and one
of the missing ones matters.**

An update downloads a release archive that contains the application only. The
web server configuration, the service scripts and the update script itself are
part of the container image, and an update from the interface does not — and
cannot — replace them. It never could; this was simply never stated.

The consequence: **0.3.2 removed a path (`/__recovery/`) that exposed the
recovery interface, which has no login of its own, to anyone who could reach
your CloudGate.** That fix is in the web server configuration. If your
installation has only ever updated through the interface, it is running the
corrected application behind the uncorrected configuration — and is still
exposed, while the version number says otherwise.

**To actually close it, pull a new container image and recreate the
container** — for Compose, `docker compose pull && docker compose up -d`.

CloudGate now checks for this on every start. If your image is affected, it
writes an error to the log and marks the container image as failed under
Settings → subsystem checks, with the command to run. The same applies, less
urgently, to the unprivileged recovery service (0.3.3) and the interrupted-
update recovery (0.3.4 and 0.3.6): those also arrive only with a new image.

---

## [0.3.6] — 2026-09-18

### Fixed

- **Bulk import could not create Minecraft or raw TCP/UDP hosts.** The import
  never carried a protocol, so every row was checked as if it were an HTTP
  host and refused by any playit tunnel — which carries neither. Rows can now
  say `protocol` (`tcp`, `udp`, `http`, `https`), and it defaults to `http` as
  before.

  The 0.3.4 notes claimed this was already fixed. It was not: the underlying
  ownership lookup was corrected, but the import still had no way to say what
  kind of host it was creating, so the outcome for a playit tunnel was the
  same rejection for a different reason. Apologies for the wrong entry.

- **An update interrupted while unpacking could leave a half-written
  installation that looked intact.** The new version is copied from the data
  volume onto the application volume, which cannot be done in one atomic step,
  so a power cut partway through left a directory that existed but was
  incomplete — and the recovery added in 0.3.4 only looked for a *missing*
  one. The copy now lands under a temporary name and is put in place in a
  single step that cannot be interrupted halfway, and any leftover partial
  copy is discarded on the next start.

- Two input fields on the Playit page still showed English placeholder text.

### Verified

The self-update path was exercised end to end for the first time against a
real release: 0.3.4 → 0.3.5 in a container, including the mandatory checksum,
the snapshot of both the application and the database, the migration step, and
the health check. Malformed version strings — including a path-traversal
attempt — are refused before anything is downloaded.

---

## [0.3.5] — 2026-09-18

### Fixed

- **The example Compose file pointed at an image that does not exist.** Images
  are published as `v0.3.5`, with the `v`; the pin added in 0.3.4 left it out,
  so `docker compose pull` failed with "manifest unknown". If you copied that
  file, this is the line to correct.
- Three pages — Playit, Backup and the API documentation — were in English no
  matter which language you had selected. They are translated now, and the two
  language files are checked to hold exactly the same set of entries so a
  missing one cannot quietly show a key name instead of text.

### Changed

- **Lists show placeholder rows while they load** instead of the word
  "loading". A short line of text where a table is about to appear made a slow
  page look like an empty one.
- **Empty lists explain themselves** with a muted icon and, where there is an
  obvious next step, the button for it right there — rather than one dimmed
  sentence that read more like something had failed to load.
- Pages fade in briefly when you navigate. Short enough not to be a wait, long
  enough that the change registers. Off entirely when the system asks for
  reduced motion, like the rest of the app's motion.

### Documentation

- `CLAUDE.md` described an `update-manifest.json` with upgrade gating
  (`min_upgrade_from`, `breaking_changes`) as though it shipped. None of it
  exists: no file is produced, none is read, and nothing stops an installation
  from jumping between any two versions. The section now states what the
  updater actually does and marks the rest as planned. The pull-request
  checklist asked contributors to update that same non-existent file.

---

## [0.3.4] — 2026-09-18

### Security

- **Live updates no longer put your session token in the URL.** The event
  stream is the one connection a browser cannot send a header on, so its
  credential travelled as a query parameter — and nginx writes the full
  address of every request to its log. It now uses a ticket that is fetched
  separately, lasts a minute, and is accepted nowhere else.
- **Creating a host through the assistant or a bulk import is now checked the
  same way as through the form.** Both skipped the checks that the tunnel is
  yours, that it can carry the protocol you picked, and that the hostname
  belongs to the chosen zone. Bulk import also rejected playit tunnels
  outright, no matter who owned them.
- The Cloudflare tunnel configuration is written with the same strict
  character rules the nginx configuration already used.

### Fixed

- **An update interrupted at the wrong moment left an installation that could
  not start.** While the new version is swapped in, the old one is briefly
  moved aside; a power cut or a killed container in that window left nothing
  in place and nothing to notice. The old version is now put back on the next
  start.
- **Finishing the first-time setup left you on the form you had just
  completed.** The page moved on before the app had caught up that the
  password was set, and got sent straight back.
- Two tests that guard against a process-supervisor race failed at random
  under load because they measured time instead of waiting for what they
  actually needed.

### Changed

- The example Compose file pins an exact version rather than `latest`, and
  forbids the container from gaining privileges it did not start with.
  CloudGate updates itself and walks migrations in order; pulling a floating
  tag can skip past that.

---

## [0.3.3] — 2026-09-18

### Security

- **The recovery interface no longer runs as root.** It is the one service
  with no login of its own — it has to work when everything else is broken —
  and it can move `/data` aside or restore a database over the live one. It
  now runs as an unprivileged account that can reach nothing but `/data`.
  If you set `PUID`/`PGID`, it uses those; otherwise it uses `1000:1000`,
  and `/data` is set to match on every start.

  The main application still runs as root. It reloads nginx after deploying a
  host and drives the self-updater, both of which need privileges that cannot
  be given up without a larger rework. That is tracked separately rather than
  rushed into a security release.

### Fixed

- `/data/db` and `/data/secrets` could end up owned by root even when
  `PUID`/`PGID` were set, because ownership was applied before those
  directories existed. It is now applied again once they do.

---

## [0.3.2] — 2026-09-18

A security release. Two independent audits went over the codebase; every
finding below was reproduced in the code before it was fixed. **If you run
CloudGate exposed to the internet, update.**

### Security — please update

- **The recovery interface was reachable from the internet.** In normal
  operation nginx forwarded `/__recovery/` to the recovery service, which has
  no login of its own. Anyone who could open your CloudGate could read the log
  file containing the initial admin password, or wipe `/data` outright. The
  route is gone from normal mode; recovery mode still serves it exactly as
  before, so a broken install is still repairable.
- **A host entry could inject configuration into nginx and cloudflared.**
  `forward_host` and `path_prefix` were written into the generated config
  unchecked, so a crafted value could add its own directives — including one
  that serves the container's filesystem over HTTP, which would expose the
  encryption key and the database. Both fields are now restricted to values
  that cannot escape a directive, checked when saved, again when the config is
  rendered (so existing entries are covered too), and on all three paths that
  create hosts: the form, bulk import, and the assistant.
- **The updater installed archives it had not verified.** A missing checksum
  file downgraded the install to "run whatever was downloaded". The checksum is
  now mandatory and a failure aborts the update. Signature checking stays
  best-effort for now — releases are not signed yet, and requiring it today
  would stop every existing installation from updating.
- **The version to install was never validated** and reached a `rm -rf` in the
  update script, where a crafted value could delete `/data/secrets` and leave
  the install unrecoverable. It is now checked in the API, in the updater, and
  in the script itself.
- **Five failed logins locked out everybody.** CloudGate did not tell Express
  it sits behind nginx, so every request looked like it came from `127.0.0.1`:
  the login limiter counted all attempts against a single bucket, and the audit
  log recorded `127.0.0.1` as the source of everything. Real client addresses
  now arrive intact.
- **Read-only API keys could download a full backup**, which contains the
  encryption key, the JWT key and every Cloudflare token — making "read-only"
  a full-secrets key. They are now refused.
- **The backup passphrase travelled in the URL**, landing in nginx and
  application logs. The download now sends it in the request body.
- **The initial admin password was written to the log file** on first start,
  where it stayed after the password was changed. It is only written to
  `/data/secrets/initial-admin.txt` now, as documented.
- **The playit account secret was written to the log file** on every agent
  start and restart. It is redacted from log output now. (It is still visible
  in the process list to anything running on the same machine — moving it out
  of the command line needs a change we could not verify against the agent
  yet.)
- **Changing your password now ends every other session.** Previously a stolen
  token stayed valid for up to eight hours after you changed your password —
  exactly the situation a password change is meant to end. The tab you change
  it in stays signed in.
- **The detailed health endpoint now requires a login.** It reported the exact
  version, which secrets exist and disk pressure to anyone who asked. The
  simple health check stays open for Docker.
- **Certificate requests are throttled** to one attempt per host every ten
  minutes. Nothing stopped a retry loop before, and Let's Encrypt limits are
  weekly — exhausting them locks a domain out of new *and* renewed
  certificates for days.
- **The playit agent was downloaded and run without any check.** The download
  pointed at "whatever is newest" and the checksum was a placeholder the code
  treated as "skip verification", so whatever arrived was made executable and
  started. It is now pinned to agent v1.0.10 and verified against a real
  checksum before it is allowed to run — and on Windows, the build the vendor
  signs. The macOS entry pointed at a file that does not exist upstream and
  has been removed.
- **Turning off two-factor authentication now needs a code from your
  authenticator**, not just your password. Switching it on always required
  one; switching it off did not, so anyone with your password and an open
  session could quietly remove it.
- **A two-factor code can only be used once.** It used to stay valid for the
  rest of its 30-second window, so a code someone saw you type was still good
  for a few seconds afterwards.
- **The container image now verifies what it installs.** cloudflared is pinned
  to an exact version and checked against a known checksum instead of being
  pulled from "whatever is newest", s6-overlay's archives are checksummed, and
  Node is installed from a signed package repository rather than by piping a
  downloaded script into a root shell. Two builds of the same CloudGate
  version now produce the same image.
- **The release and CI workflows pin every external build step to an exact,
  immutable revision**, so a moved tag cannot change what runs in a job that
  is allowed to publish releases and images.
- **The recovery interface refuses requests a browser reports as coming from
  another site.** Its confirmation phrases are public — they are in the
  source — so they stop accidents, not attacks. Access from a terminal is
  unaffected.
- API key generation had a slight bias in its character distribution, and a
  failure inside the authentication middleware could hang a request instead of
  returning an error. Both corrected.

### Fixed

- **Hard reset in the recovery interface could not work, and said otherwise.**
  It tried to move `/data` to a folder next to it, which sits outside the
  storage volume — an impossible move that failed on the first file, and on
  any setup where it did go through, the "archived" keys and database were
  discarded the next time the container was recreated, while the screen
  promised they were safe. Everything is now archived inside `/data` itself,
  and a partial failure is reported instead of silently leaving half a
  directory behind.
- The container health check's recovery fallback never worked: it asked for a
  path that only existed in normal mode, so in recovery mode — the one case it
  was written for — it always failed.
- A single malformed environment variable made CloudGate ignore **all** of
  them and start on defaults, so a custom data directory could be silently
  dropped. Only the invalid variable falls back now.
- Restoring a database backup no longer accepts a file that is not a database.

---

## [0.3.1] — 2026-09-18

### Added — Cloudy lives in the app now

- **He is always there.** Instead of appearing only for a task, Cloudy stands
  at his spot and, when nothing is going on, strolls somewhere else every half
  minute or so for a small emote. He stays out of the way: never while you are
  in the chat, a dialog or the guided tour, never on top of a control, and not
  at all when the tab is in the background or "reduce motion" is on. After a
  few quiet minutes he falls asleep and wakes on your next mouse move.
- **Seven new emotes:** smitten (heart eyes, on the support page), thinking,
  shrugging, confused, dancing, sitting and yawning.
- **Signs with symbols.** He holds up a drawn heart, star, check, question,
  warning or sparkle — the heart on the support page, a sparkle on the update
  page, a warning when something just failed.
- **He sits on the enlarged QR code** on the support page and goes back to his
  spot when you close it.
- **Watching him work.** When you give him a task the chat closes, so you can
  see him walk to the pages and controls the task touches.

### Fixed — Cloudy's placement

- He could stand partly outside the window after a resize or a reflow; his
  position is now kept inside the window at all times, and his resting spot
  follows the chat button instead of a fixed corner.
- During the guided tour he could end up behind the step's tooltip; he now
  picks a side that leaves both the highlighted element and the tooltip free.

### Changed — cards and controls react to the mouse

Cards lift slightly on hover; cards you can click lift further, get an accent
edge and animate their icon. Buttons, icon buttons and switches were already
animated in 0.3.0 and keep that behaviour.

---

## [0.3.0] — 2026-09-17

### Added — meet Cloudy

CloudGate has a mascot. Cloudy is a small cloud with arms and legs, drawn as
SVG and animated with CSS — he idles, walks, waves, points, works, cheers and
sleeps, and he can hold up a little sign.

- **He is the assistant.** The AI button is now Cloudy, and so is his face in
  the chat. Give him a task and he steps out of the chat window, walks across
  the UI to the pages and controls the task touches, works there, cheers when
  he's done and returns to his spot.
- **He hosts the guided tour.** Cloudy walks along and stands next to whatever
  the current step is talking about.
- **He asks for support, rarely.** After every twelfth change you make — at
  most once a day, never while he is busy — he strolls in with a heart sign and
  a link to the support page. Tap him to send him away.

Everything he does respects the "reduce motion" system setting: he then simply
appears where he is needed instead of animating there.

### Changed — clearer hover feedback

Icons inside buttons, links and the sidebar give a short playful wobble on
hover, and switches show a ring and a knob that leans towards the side it would
move to. The previous version's feedback was too subtle to notice.

---

## [0.2.9] — 2026-09-17

### Fixed — copy buttons did nothing on LAN installs

Every "copy" button (donation addresses, public endpoints, API keys, the Home
Assistant remedy snippet) silently failed when CloudGate is reached over plain
`http://`, because browsers only expose the clipboard API in a secure context.
They now fall back to the classic copy path and work everywhere.

### Fixed — translations after an update

Right after an update the UI could show raw keys such as
`tour.next_progress` instead of a label: the browser still had the previous
release's cached translation files. Translations are now requested per version.

### Added — tablets and foldables get the phone layout

Devices without a mouse keep the phone layout up to 1200px wide, so unfolded
foldables and tablets no longer get a cramped desktop layout with controls that
need hover. Mouse and trackpad devices are unchanged (switch at 768px).

### Changed — interaction feedback

- Sidebar entries show an outlined, raised state on hover; icons inside buttons,
  links and switches scale slightly, so clickable things announce themselves.
- Switches show the pointer cursor and react to hover.
- Selectable rows (Cloudflare and Playit accounts) read as buttons: a rounded
  outline on hover, and the selected one is an orange-tinted rounded surface.
  The orange bar on the left edge is gone.
- Tooltips follow the mouse at an offset so the cursor never covers the text,
  and use the app's surfaces, radius and shadow. The deliberate delay before
  they appear is unchanged.

### Changed — AI assistant chat

Now follows the new design language and works on phones: full-width sheet from
the bottom with rounded top corners, distinct bubbles for your own messages,
correct colours in the light theme, and long code blocks scroll inside the
bubble instead of stretching the panel.

### Changed — support page

- QR codes open large on click, with the rest of the UI blurred behind them;
  clicking again or Escape closes them.
- The PayPal icon is readable in the dark theme.
- Removed the redundant "one-click PayPal" badge.

### Added — dashboard shortcuts

The CloudGate version card opens the update page, and the deployment-error
notice opens the hosts page.

---

## [0.2.8] — 2026-09-17

### Fixed — light theme

- The page background stayed dark in the light theme, and navigation and
  heading text inherited a near-white colour on it. The light theme now uses a
  light grey ground with white surfaces and dark text.
- Accent icons (logo, AI assistant, health indicators) use darker shades in the
  light theme so they stay readable on white; shadows are softer there.

### Fixed — guided app tour

- Starting the tour after onboarding or via `?tour=replay` did nothing: removing
  the URL parameter cancelled the pending start.
- Stops on other pages were skipped at random, because the tour resumed after a
  fixed delay instead of waiting for the page to render its target.
- The "Next" button (with step progress) was always English, even with the
  German UI.
- Phones: the navigation stop points at the menu button instead of the hidden
  sidebar, and stops on long lists highlight the first entry so the tooltip
  stays on screen. The tooltip fits the screen width.
- The tooltip follows the new design (surface colours, shadow, rounded buttons)
  in both themes.

### Changed — interaction feedback

- Buttons and icon buttons lift slightly on hover and settle when pressed;
  navigation entries shift on hover. Respects "reduce motion".
- Selectable lists (Cloudflare and Playit accounts) show a clear hover state,
  and the selected account gets an orange tint with an accent edge — previously
  the selection was barely visible in dark mode and dark-on-light in light mode.

### Fixed — layout

- Audit log: the `{}` details chip sat below the row centre; it is now
  vertically centred. On phones it sits beside the entity and IP lines.
- Onboarding: the horizontal stepper overflowed the page on tablets and small
  laptops; it switches to the vertical layout below 1200 px.

---

## [0.2.7] — 2026-09-17

### Changed — new design language

The whole Web UI follows a new design (made in Penpot) built from floating
surfaces:

- Cards, the header, buttons, the active navigation entry and the AI button
  cast a soft drop shadow. Inputs, checkboxes, switches and segmented controls
  sit recessed with the same shadow inset. Badges, radios and alerts get a
  faint one. Controls inside modals and drawers pick this up too.
- The header has rounded bottom corners. On desktop the sidebar floats below
  it and is only as tall as its content.
- The AI assistant button moved to the bottom **left** and is a rounded square.
  The chat drawer still opens from the right.
- Tables (Hosts, Tunnels, API keys, Audit log, Cloudflare, Playit) centre
  badge, code and switch columns. Hosts shows a shortened public endpoint
  (`•••.cfargotunnel.com`); the copy button still copies the full value.
- Audit log details open as formatted JSON in a popover instead of an inline
  blob.
- Login, restore and password-change cards are centred on the screen.
  The login title now reads "Sign in to your CloudGate".

### Added — mobile / responsive layout

CloudGate is now usable on phones and tablets:

- Below 768 px the sidebar becomes a full-screen menu behind a burger button
  and closes after you pick a page.
- Every table turns into a list of cards on phones, with all actions kept as
  large touch targets. On wider screens tables scroll inside their card
  instead of widening the page.
- Forms, dashboard stats, the onboarding wizard (vertical stepper), the
  donation page (QR above address) and the API docs (description below
  method + path) reflow to a single column.
- Long values such as the Cloudflare account ID are shortened with an ellipsis
  on phones; the full value stays available on hover.
- Page content keeps clear of the floating AI button.

No migrations, no settings changes and no persisted paths touched — this is a
frontend-only release.

---

## [0.2.6] — 2026-08-12

### Fixed — Home Assistant answered "400: Bad Request" through every tunnel

Home Assistant behind a CloudGate tunnel returned a bare **400 Bad
Request** to every browser and to the companion app, while the LAN
address kept working and push notifications kept arriving. Other
services on the same tunnel were unaffected, which made it look like a
CloudGate routing bug. It is not.

HA's `forwarded_middleware`
(`homeassistant/components/http/forwarded.py`) raises `HTTPBadRequest`
whenever a request carries `X-Forwarded-For` and either
`use_x_forwarded_for` is off (HA's **default**) or the connecting peer
is absent from `trusted_proxies`. Cloudflare's edge adds
`X-Forwarded-For` to *every* proxied request, and cloudflared has no
option to strip or rewrite it — so an unconfigured HA rejects 100% of
tunnel traffic. LAN requests carry no such header, and push
notifications leave HA outbound via HA Cloud, which is why both kept
working and hid the cause.

The fix has to be applied in Home Assistant. CloudGate now finds it for
you instead of leaving a bare 400:

- **New forwarded-header probe.** After a deploy — and on demand via the
  new read-only `GET /api/hosts/:id/diagnose` — CloudGate requests the
  origin twice, once plain and once with `X-Forwarded-For`. A clean
  "works, then 400s" transition is reported as the cause rather than as
  a generic "upstream returned 400".
- **The diagnosis carries the remedy.** CloudGate detects Home Assistant
  and emits a ready-to-paste `configuration.yaml` block containing the
  address it actually reaches the origin from. It recommends the `/24`
  rather than the pinned container IP, because Docker hands the
  container a new address on every re-create — the most common way this
  fix silently breaks again a week later.
- **Corrected misleading advice.** 0.2.1 suggested `http_host_header`
  and `trusted_proxies: [127.0.0.1]` for this symptom. Neither works:
  the check never looks at the `Host` header, and CloudGate connects
  from a Docker bridge address, not localhost. The hint and the field
  help text have been rewritten.
- New `docs/HOME-ASSISTANT.md` covers the root cause, the fix, the usual
  mistakes, and why the companion app can still fail afterwards when
  Cloudflare Access is enabled on the hostname.

### Fixed — local_nginx hosts could never deploy

The nginx host template was rendered by a Liquid engine configured with
`trimOutputLeft: true`, which strips the whitespace to the left of every
`{{ … }}`. `server {{ forward_host }}:{{ forward_port }};` therefore
rendered as `server192.168.1.50:8123;`, and `server_name {{ hostname }};`
as `server_nameha.example.com;`. Both are unknown directives, so
`nginx -t` rejected the file and `writeHostConfig()` rolled back — every
`local_nginx` deploy failed. The TLS branch had a matching defect that
ran `listen 443 ssl http2;` onto the end of the `server_name` line.

Whitespace control is now explicit (`{%-` / `-%}`), and the new
`tests/nginx-host-template.test.ts` renders each variant and runs it
through a real `nginx -t` so a string-level regression cannot slip
through again.

### Fixed — `Connection: upgrade` was sent on every request

The nginx template hard-coded `proxy_set_header Connection "upgrade";`,
announcing a protocol upgrade even for ordinary requests that never
asked for one. This defeats keep-alive and upsets strict origins. Each
host config now declares its own `map $http_upgrade $cg_conn_upgrade_<id>`
so `Connection` is `upgrade` only for real WebSocket handshakes and
`close` otherwise.

The map is deliberately per-host and id-suffixed: the self-updater
replaces `/app` but never `/etc/nginx-cloudgate/`, so a generated host
file may not depend on anything declared in the image-level config.

### Added — forwarded-header control for `local_nginx` hosts

New per-host advanced option `forwarded_headers`:

| Value | Behaviour |
|---|---|
| `standard` (default) | Appends CloudGate's hop, preserving the client IP. Unchanged behaviour. |
| `client_ip_only` | Sends exactly one `X-Forwarded-For` entry, for origins that choke on multi-hop chains. |
| `strip` | Sends no `X-Forwarded-*` at all — makes Home Assistant work with no HA-side configuration. |

`strip` is a documented trade-off, not a recommendation: the origin then
sees every visitor as CloudGate, so its per-client brute-force banning
can no longer tell clients apart and one attacker can get everyone
banned. `trusted_proxies` remains the recommended fix.

The setting has **no effect** in `cloudflare_tunnel` mode, and the UI
says so — Cloudflare attaches the header at its edge, upstream of
anything CloudGate controls.

### Changed — nginx hosts no longer cap request bodies at 1 MB

`client_max_body_size 0` defers the limit to the origin, which is the
side that knows. nginx's 1 MB default silently broke uploads, backup
restores and media sync. `large_client_header_buffers 4 32k` was raised
for the same reason: Cloudflare's cookies overflow the 8 KB default and
nginx rejected those requests with a 400 of its own before the origin
ever saw them.

No migration is required for this release — `forwarded_headers` lives in
the existing `proxy_hosts.advanced_options` JSON column added in 0.2.1.

---

## [0.2.5] — 2026-07-06

### Fixed — hosts orphaned again on every Cloudflare zone re-sync

0.2.4 recovered hosts orphaned by migration 004's one-time table
rebuild, but a second, recurring source of the same symptom
survived: **zone sync**. `doZoneSync` refreshed the cached zone list
by `DELETE`-ing every `cf_zones` row for the account and re-`INSERT`ing
them — which handed each zone a brand-new auto-increment `id`. Because
`proxy_hosts.cf_zone_id` references `cf_zones.id` with
`ON DELETE SET NULL`, every host attached to a zone had its
`cf_zone_id` NULLed on **every** sync (the "Sync" button, and the
automatic sync when adding an account). The host then failed to
publish its DNS record ("host has no cf_zone_id …") and the browser
saw a 404.

- Zone persistence now **upserts** on the `(cloudflare_account_id,
  zone_id)` unique key, so existing zone rows keep their primary-key
  `id` and attached hosts stay bound. Zones Cloudflare no longer
  returns are pruned (SET NULL on their hosts is correct there — the
  zone is genuinely gone).
- New regression test `tests/zone-sync.test.ts` asserts a re-sync
  preserves `cf_zone_id` and that stale zones are pruned.

### Fixed — dashboard falsely reported cloudflared "down"

The deep health check (`GET /api/health/deep`) probed a hardcoded
`127.0.0.1:36500`, but since 0.2.2 each tunnel binds its own metrics
port (`36500 + tunnel id`) to avoid multi-tunnel collisions. The
check therefore always missed the real port and reported cloudflared
unreachable even on healthy systems. It now enumerates the
cloudflared tunnels and probes each tunnel's actual metrics port.

### Fixed — migrations + tests broken on Windows dev machines

- `db.ts` derived the migrations directory via `new URL(...).pathname`,
  which yields `/C:/…` on Windows and made Knex miss the migrations
  folder. Now uses `fileURLToPath()` (the same idiom already used in
  `knexfile.ts` / `run-migrations.ts`).
- Vitest now loads migration `.ts` files through the `tsx` loader and
  allows a longer bootstrap hook/test timeout, so the required
  bootstrap/persistence/updater suites run on Windows too (they were
  already green on the Linux CI).

---

## [0.2.4] — 2026-05-25

### Fixed — root cause of "tunnel assignment got reset"

Migration 004's `.alter()` calls on the `tunnels` table forced a
SQLite table rebuild (no native `ALTER COLUMN`). Knex sets
`PRAGMA foreign_keys=OFF` around the rebuild, but in some
better-sqlite3 connection-pool configurations the pragma doesn't
stick to the connection doing the work. When that happens the
`DROP TABLE tunnels` step fires the `proxy_hosts.tunnel_id ON DELETE
SET NULL` cascade, orphaning every host. The browser then sees
cloudflared's `http_status:404` because `buildContext` filters out
hosts with `tunnel_id IS NULL`.

**Migration 008** detects + recovers:
- If exactly one cloudflared tunnel exists, every orphan is
  re-attached to it automatically.
- Otherwise each orphan gets a clear `last_error` pointing at the
  new Reassign UI.

### Added — tunnel + zone are now editable

Previously the edit modal locked tunnel/zone as immutable. After
0.2.0+ that turned into "I have no way to fix an orphaned host
without deleting and re-creating it from scratch". `EditHostModal`
gains a **Reassign tunnel/zone** panel (auto-opens for orphans),
with cross-validation: protocol must match the new tunnel's
provider, hostname must end with the new zone's name. The backend
tears the host down from the old tunnel/zone before mutating —
no orphan DNS records.

### Fixed — false-positive DNS warning on hosts that work

Post-deploy the backend was polling 1.1.1.1 DoH for the new CNAME
and storing the timeout as `last_error` when the resolver didn't
see the record within 12s. But 1.1.1.1 caches negative responses
for a few minutes, so a brand-new record often "doesn't exist" via
DoH while the browser (which hits Cloudflare's edge directly) sees
it fine. Working hosts displayed a red error badge for hours.

- `no_record` and `timeout` outcomes now go into a non-blocking
  `meta.last_warning` slot instead of `last_error`. The host stays
  "deployed" in the UI.
- Only `nxdomain` and `wrong_target` (genuine misconfigurations)
  still surface as `last_error`.
- Wording softened from "⚠" to "ℹ" with explicit "if the page loads
  you can ignore this".

### Tests

Existing tests cover the contract; the orphan-recovery migration's
behaviour is asserted in CI via the migration apply step on a
seeded broken state.

---

## [0.2.3] — 2026-05-25

### Fixed — "live and running but page not found"

After the 0.2.2 metrics-port fix, the cloudflared daemon stayed up and
`/ready` returned 200 — so the UI happily reported `running` — but every
hostname still served Cloudflare's "page not found" page. Two
independent causes, both fixed here:

**1. Stale `tunnelUuid` after Recreate.**
`CloudflaredProvider.stop()` killed the daemon but **left the
`CloudflaredProcess` instance in its in-memory cache**. The next
`start()` reused the cached instance — including the `tunnelUuid`
baked into its constructor at boot time. After a Recreate (the DB
row's `tunnel_id` changes to the new UUID), cloudflared therefore
spawned with the OLD UUID positional arg even though `config.yml`
pointed at the NEW one. Result: the daemon connected to Cloudflare as
the wrong tunnel (or failed auth and respawned silently), the DNS
CNAME pointed to the NEW UUID's `cfargotunnel.com` target, and CF had
no daemon answering for the right UUID.

Fix: `stop()` now deletes the entry from the cache. The next `start()`
constructs a fresh `CloudflaredProcess` with the current DB state.

**2. Hosts silently dropped from `config.yml` ingress when `protocol IS NULL`.**
`buildContext` used `whereIn('protocol', ['http','https'])` which
doesn't match `NULL`. If migration 004's backfill didn't take on some
rows (we've seen this on installs that paused mid-upgrade), those
hosts disappeared from the rendered config. cloudflared then served
its `http_status:404` catch-all for them — the "page not found" UI
behaviour. Now `buildContext` treats `NULL` as `http` and migration
007 backfills any straggling rows.

### Added — recovery + diagnosis

- **`POST /api/tunnels/:id/force-sync`** + 🔄 sidebar button (orange,
  next to logs). One-click recovery: drops the cached process,
  re-renders config from current DB, restarts fresh, re-deploys every
  host so DNS records re-converge. Idempotent.
- **`/api/admin/diagnostics`** now includes:
  - the full rendered `cloudflared/config.yml` so the user can verify
    what cloudflared actually sees,
  - per-tunnel attached-host audit listing which rows would land in
    ingress and which would be silently excluded (and why).
- **Stale cred file cleanup**: `CloudflaredProvider.ensureCredentialsFile`
  now sweeps `/data/cloudflared/*.json` for UUIDs no DB row owns — kills
  the ambiguous-credentials-on-disk failure mode after Recreate.
- **`upsertCnameRecord` / `upsertSrvRecord` fall back to `create()`
  on 404** when the persisted `dns_record_id` no longer exists at
  Cloudflare (manual dashboard deletion, side effect of tunnel delete,
  etc.). Previously every deploy threw and the host never recovered.

### Migration 007

Backfills `proxy_hosts.protocol = 'http'` for any row left with
`NULL` by migration 004. Purely additive, idempotent, no-op `down()`.

### Tests

- `cloudflared-stop-clears-cache.test.ts` — direct regression for the
  cache-invalidation contract that the stale-UUID fix relies on.

---

## [0.2.2] — 2026-05-25

### Fixed — cloudflared "address already in use" respawn loop

The 0.2.1 install kept logging:

```
Error opening metrics server listener: failed to bind to address (127.0.0.1:36500): listen tcp 127.0.0.1:36500: bind: address already in use
```

…every 1 / 2 / 4 / 8 / 16 / 32 / 60 seconds, forever. Root cause was a
race in `ManagedProcess`: when a manual `start()` came in while the exit
handler had already queued a backoff respawn (`setTimeout`), the queued
spawn fired ~ms after our manual spawn and overwrote `this.child` with
a second instance. The first child kept the metrics-port listener, the
second couldn't bind, exited, queued another backoff, repeat.

- **Supervisor tracks the pending backoff timer** and cancels it on
  `start()` / `stop()`. No more racing respawns against a queued one.
- **`spawnOnce()` kills any live `this.child` before spawning**
  (belt-and-braces — the cancellation above should mean we never enter
  with a live child, but the kill catches anything we missed).
- **`exit` handler only nulls `this.child`** when it still points at
  the exited process (avoids clobbering a freshly-spawned successor).

### Fixed — multi-tunnel installs collided on the metrics port

The cloudflared metrics listener was hardcoded to `127.0.0.1:36500`, so
once you had two CF tunnels the second one always failed to bind. Each
`CloudflaredProcess` now gets `127.0.0.1:36500 + tunnelDbId` derived
from its DB row. Single-tunnel installs that have just `id=1` now bind
36501 — picked deliberately so cached "what was that port again" muscle
memory doesn't conflict if you happened to know about 36500.

### Added — orphan-cloudflared sweep on Linux

Before spawning, `CloudflaredProcess.start()` walks `/proc/*/cmdline`
and `SIGKILL`s any other `cloudflared` process whose command line
mentions our tunnel UUID. Belt-and-braces safety net for cases where
the supervisor genuinely lost track of a child (across an upgrade, a
crash + restart, or someone exec'd cloudflared manually in the
container). No-op on non-Linux.

### Tests

- `managed-process-race.test.ts` — repro for the supervisor race:
  start during a queued backoff must result in exactly one extra
  spawn, not two. Stop during a queued backoff must result in zero.

---

## [0.2.1] — 2026-05-25

### Fixed — broken tunnels after 0.2.0 upgrade

Migration `004` made several `tunnels` columns nullable via knex's
SQLite `.alter()` table-rebuild path, and some installs came out with
cloudflared tunnel rows that ended up with `NULL` in
`encrypted_tunnel_secret` / `account_tag` / `credentials_path`. The
cloudflared daemon never started, every host returned an error, and
the only available remedy was to wipe `/data` and start over. Not
acceptable.

This release contains both detection and recovery:

- **`CloudflaredProvider.start` is now tolerant** — missing credentials
  surface as `provider_meta.last_error` ("needs re-link") and the boot
  sequence continues. One bad tunnel can no longer brick the whole
  install.
- **Migration `005` flags damaged tunnels** at upgrade time — it scans
  for the breakage signature and marks affected rows `status='error'`
  with an actionable message instead of leaving them in an unexplained
  "stopped" state.
- **New `POST /api/tunnels/:id/recreate`** + sidebar "🆘 Re-create"
  button. Creates a fresh Cloudflare tunnel under the same account,
  swaps the UUID + secret in place, and re-deploys every attached host
  so DNS records point at the new `cfargotunnel.com` target. Hosts and
  their configuration survive.
- **`buildContext` silently skips hosts** with invalid `forward_host` /
  `forward_port` so a single corrupt row can't drop the whole tunnel's
  ingress.

### Fixed — HomeAssistant "400 Bad Request" and similar proxied apps

HomeAssistant rejects proxied requests it doesn't recognise via
`trusted_proxies` + Host-header matching. CloudGate now exposes the
relevant cloudflared `originRequest` knobs per host:

- **HTTP Host header override** (`http_host_header`) — pin the Host
  header sent to origin (`homeassistant.local:8123` or your LAN IP).
- **Origin server name** (SNI) for HTTPS origins with mismatched certs.
- **HTTP/2 origin**, **no Happy Eyeballs**, **disable chunked encoding**.
- **Connect timeout** override.

Surfaced via a new "Advanced (originRequest)" panel in the Edit Host
modal. Schema lives in `proxy_hosts.advanced_options` (migration `006`).

### Added — encrypted Backup &amp; Restore UI

New `/backup` page (admin-only) with two cards:

- **Export** — passphrase → `cloudgate-backup-YYYY-MM-DD….cgbk`. The
  archive contains the SQLite DB, all secrets, Cloudflare tunnel
  credentials, nginx custom snippets and Let's Encrypt certs.
- **Import** — file upload + passphrase + explicit overwrite
  confirmation. Calls the admin `POST /api/restore?force=true` path;
  container restart required afterwards.

The backup format itself was extended to include `nginx/custom` and
`nginx/certs` (previously omitted) so a restored install boots with the
user's full reverse-proxy state intact. `cloudflared/bin` and
`playit/bin` are deliberately skipped — they're downloadable.

### Added — `/api/admin/diagnostics`

Admin-only endpoint that dumps SQLite `PRAGMA integrity_check`,
migration history, row counts, null-column survey on critical tables,
and `/data` path presence. No secrets. Intended as a "paste-into-issue"
JSON when triaging post-upgrade problems.

### Security

- **Fixed an ownership-validation bug** on `POST /api/hosts` introduced
  by 0.2.0: the `.orWhereNotNull('tunnels.provider_meta')` fallback
  matched every tunnel (all rows have `provider_meta='{}'`), so an
  authenticated user could attach a host to a tunnel they didn't own.
  Single-user installs were unaffected in practice — fixed regardless.

---

## [0.2.0] — 2026-05-24

### Added — pluggable tunnel-provider abstraction + Playit.gg for TCP/UDP

CloudGate can now host **Minecraft servers** (Java + Bedrock), SSH, and arbitrary TCP/UDP services that Cloudflare Tunnel can't deliver to vanilla clients on the free plan. Done via a new `TunnelProvider` interface so additional backends (ngrok, FRP, …) can be added without touching `host-deploy`.

**New host types in the UI:**
- **Web app (HTTP/HTTPS)** — existing behaviour, via cloudflared.
- **Minecraft (Java Edition)** — TCP via Playit.gg. CloudGate auto-creates an SRV record (`_minecraft._tcp.<host>`) on your Cloudflare zone so vanilla Java clients connect with just the hostname.
- **Minecraft (Bedrock Edition)** — UDP via Playit.gg. SRV is not supported by the Bedrock client; the UI shows the exact `host:port` players paste into the Servers tab.
- **Raw TCP / Raw UDP** — anything else (SSH, game servers, custom services).

**Under the hood:**
- New `ManagedProcess` base class — shared supervisor (spawn, log ring buffer, exp-backoff restart, health FSM) for cloudflared and playit-agent.
- `TunnelProvider` interface + registry resolves `tunnels.provider` to the right implementation.
- `host-deploy.ts` dispatches via `provider.addHost()` and writes the right DNS record kind per returned `ProviderEdgeEndpoint` (CNAME / SRV / `host_port`).
- Playit account-linking page with TCP/UDP quota bar (Playit free tier: 4 TCP + 4 UDP per account).
- Playit-assigned external endpoint shown on the Hosts list with a copy button — critical for Bedrock since players need the literal `host:port`.

### Database — migration `20260524_004_tunnel_providers.ts`

Purely additive per `CLAUDE.md` §3:
- `tunnels.provider` (default `'cloudflared'`), `tunnels.provider_meta` (JSON), `tunnels.playit_account_id` (nullable FK).
- CF-specific tunnel columns (`cloudflare_account_id`, `encrypted_tunnel_secret`, `credentials_path`, `account_tag`) made nullable so Playit tunnels can co-exist.
- `proxy_hosts.protocol` (default `'http'`), `proxy_hosts.edge_endpoint` (JSON snapshot).
- New `playit_accounts` table (analog to `cloudflare_accounts`).
- Idempotent, with working `down()`. Existing HTTP hosts continue to work with zero user action.

### Bootstrap

- New step `ensure-playit-binary` — idempotent download of `/data/playit/bin/playit-agent` with sha256 verification.
- Skipped when `CLOUDGATE_PLAYIT_ENABLED=false` (locked-down installs).
- `/data/playit/{bin,logs}` added to the sacred-path list — survives updates.

### Honest limitations (documented in-app)

- Bedrock players need the literal `host:port` — UI shows it.
- Playit free tier: 4 TCP + 4 UDP per account. Quota bar surfaces usage; hitting the cap shows a clear upgrade link.
- Playit-assigned ports may change on tunnel rebuild → SRV TTL kept at 60 s; CloudGate re-reads the assigned endpoint on every `provider.reload()`.

---

## [0.1.7] — 2026-05-22

### Fixed — self-updater "migrations failed" rollback

Root cause: `knexfile.ts` had `directory: './migrations'` — a relative path that the Knex CLI resolves against the **process CWD**, not the knexfile location. `apply-update.sh` ran `cd /app/backend && node ./node_modules/.bin/knex --knexfile dist/db/knexfile.js migrate:latest`, so knex looked for migrations at `/app/backend/migrations/` (doesn't exist) instead of `/app/backend/dist/db/migrations/` (where they actually are). Every install since v0.1.0 hit this; v0.1.5+ surfaced it as the rollback marker reason because we fixed the marker, but the underlying bug was the same.

### Changed — harder, more diagnosable updates

**Dedicated migration runner** (`packages/backend/src/db/run-migrations.ts`):
- Bypasses the Knex CLI entirely — no more `--knexfile` path resolution, no shell-wrapper / symlink fragility.
- Migrations directory resolved against `import.meta.url` (the runner's own location). Cannot point at the wrong dir regardless of CWD.
- Verbose pre-flight: prints db path, migrations dir, pending list, applied list with timings.
- Falls back automatically — `apply-update.sh` uses the runner when present, the knex CLI when it's not.

**apply-update.sh hardening**:
- DB pre-flight: `sqlite3 PRAGMA integrity_check` before migrate; warns (doesn't fail) if not "ok".
- Knex/runner output captured to a temp file, last 50 lines piped into the rollback marker reason — the UI now shows the **actual error**, not just "migrations failed".
- Migration timeout 60s → 180s (native-modules can rebuild on first import).
- Health-check loop 30s → 60s + reports last HTTP status code in the rollback reason (so you can tell `500 Internal Server Error` from `connection refused`).
- `--cwd $(pwd)/dist/db` and absolute `--knexfile` path in the CLI fallback so the CWD bug can't recur even on the legacy path.

**knexfile.ts**:
- `directory:` now uses an absolute path via `dirname(fileURLToPath(import.meta.url))` — robust against any CWD knex chooses to resolve from.
- `loadExtensions: ['.js']` in production / `['.ts']` in dev — prevents `.d.ts` from being misinterpreted as migrations.
- Per-env config block, no shared cross-env state.

### Hardening summary

The update pipeline is now defensive at every step:

| Layer | What protects you |
|---|---|
| Tarball | Sanity-check fails CI if `backend/node_modules/.bin/knex` missing (v0.1.5+) |
| Apply | `node_modules` fallback from `.old/` if tarball is incomplete (v0.1.5+) |
| Migrate | Standalone runner with absolute paths + verbose logging (this release) |
| Rollback marker | Actual error tail (last 50 lines of migrate stderr) instead of "see log" |
| Health-check | 60s window + reports actual HTTP code on failure |

---

## [0.1.6] — 2026-05-22

### Added

- **DNS verification via DoH against `1.1.1.1`.** After every host deploy, CloudGate now actively queries Cloudflare's public DoH endpoint for the host's CNAME — bypassing the container's local resolver cache, so we see what the rest of the internet sees. Five typed outcomes turn into actionable warnings written to `last_error`:
  - **`nxdomain`** — "Cloudflare's resolver returned NXDOMAIN. The CNAME was NOT created — re-deploy."
  - **`no_record`** — "No CNAME after 12s — propagation lag or silent create failure. Click Re-deploy."
  - **`wrong_target`** — "Resolves to X but should point to Y. Delete the conflicting record in CF."
  - **`timeout`** — "Couldn't reach 1.1.1.1 — outbound DoH may be blocked."
  - **`ok`** — record verified, then upstream probe runs next.
- **`GET /api/hosts/:id/verify-dns`** — manual DoH check button in the UI (purple globe icon next to each cloudflare_tunnel host). On success: toast with the resolved target + TTL + a "if your browser still fails, it's local DNS cache, try Ctrl+Shift+R" hint.
- **Config Inspector for tunnels.** Purple file-icon on each tunnel row opens a side drawer showing:
  - **All hosts in DB** for this tunnel, each with `IN CONFIG` / `MISSING` / `DISABLED` badges
  - **Currently rendered `/data/cloudflared/config.yml`** as a live read from disk
  - Critical for diagnosing "DNS resolves but the browser shows 400 / nothing": almost always means the hostname isn't in the ingress YAML, which this drawer makes obvious.
- **`POST /api/tunnels/:id/redeploy-all`** — cyan refresh-dot icon on each tunnel row. Re-renders the config + re-runs `deployHost()` for every host attached to this tunnel. Recovers from cases where a previous deploy crashed before `reloadTunnel()` could finalize. Reports `{ok, failed, errors[]}` in the response.

### Why this matters

User-reported case: one host worked, three others returned Cloudflare 400 / blank pages from the browser despite DNS records visibly present in the Cloudflare dashboard. Root cause hypothesized: ingress list in `config.yml` out of sync with DB (one host got into it, others didn't because of a race between sequential creates). The Config Inspector immediately shows whether this is what's happening, and Re-deploy-all fixes it without losing data.

---

## [0.1.5] — 2026-05-22

### Fixed

**Self-updater was broken** — every install attempt (since v0.1.0) rolled back. Three intertwined bugs:

- **Release tarball was missing `node_modules`.** The release workflow did `cp -r packages/backend/dist` which packed only the compiled JavaScript — but `apply-update.sh` needs `./node_modules/.bin/knex` to run the database migration step. After the swap, the new `/app/backend/` had no node_modules → `knex` not found → migrations failed → rollback.
  - **Fix**: release.yml now runs `pnpm --filter @cloudgate/backend deploy --prod` (and same for recovery-ui) to bundle a self-contained directory with `dist/` + `package.json` + production-only `node_modules/`. The same command the Dockerfile already used for the runtime image — release tarballs now match.
  - **Sanity check**: build fails fast if `backend/node_modules/.bin/knex` is missing from the staging dir.

- **`apply-update.sh` had no fallback for incomplete tarballs.** If a future release tarball ever ships incomplete, it would brick the same way.
  - **Fix**: after the swap, if `/app/backend/node_modules/` is missing but `/app/backend.old/node_modules/` exists, the script carries it forward (same Node ABI across releases). This unblocks even broken tarballs from v0.1.0 → v0.1.4.
  - **Fix**: `KNEX_BIN` is now resolved at runtime — looks at `node_modules/.bin/knex` then `node_modules/knex/bin/knex.js`. Bails clearly with "knex CLI not found … release tarball appears incomplete" if both miss, instead of cryptic "migrations failed".

- **Rollback marker reason was useless.** The `.last-update-*.json` always said `"reason": "see /data/logs/update-history.log"` no matter what actually went wrong. The Update modal then displayed that text in the UI.
  - **Fix**: `rollback()` now accepts the actual bail-reason and writes it to the marker. The Update modal also auto-opens the Terminal-Output panel when a rollback is detected, so the user sees the real story without clicking around.

### Upgrade path

The currently-running container has the broken `apply-update.sh`. The in-app updater **cannot** apply this fix to itself (it would just roll back again with the same bug). One-time manual pull:

```bash
docker stop cloudgate && docker rm cloudgate
docker pull ghcr.io/elias02345/cloudgate:latest
docker run -d --name cloudgate -p 80:80 -p 443:443 \
  -v cloudgate-data:/data --restart unless-stopped \
  ghcr.io/elias02345/cloudgate:latest
```

All future updates will work end-to-end through the WebUI.

---

## [0.1.4] — 2026-05-21

### Added
- **Upstream connectivity probe.** After a host deploys, CloudGate now TCP-sniffs `<scheme>://<host>:<port>` from inside the container — the same network namespace cloudflared lives in. The probe classifies the listener (HTTP vs TLS by the first response byte) and writes a clear warning to `last_error` if there's a mismatch:
  - **`tls_on_http_port`** — "The service at X:Y speaks TLS but the host is configured with scheme 'http'. Edit the host, switch to https + tick 'Don't verify upstream TLS certificate'." Catches the #1 Homelab pitfall — pointing CloudGate at Proxmox/TrueNAS/Unifi with `http://` on a HTTPS-only port.
  - **`http_on_tls_port`** — Reverse case: scheme=https against a plain-HTTP service.
  - **`tcp_refused` / `tcp_timeout`** — Service down or unreachable from container.
  - **`self_signed_tls`** — Suggests ticking no-TLS-verify.
  - **`http_error`** — Service is reachable but returned 5xx.

- **`PUT /api/hosts/:id`** — edit forward_scheme / forward_host / forward_port / path_prefix / tls_options without deleting + recreating the host. Re-runs deployHost() so the tunnel config + upstream probe are refreshed automatically.

- **Edit-host modal in the UI.** Pencil icon in the actions column opens a small form to fix forwarding settings on an existing host. Includes a smart hint when the port matches a known HTTPS-default service (8006/8443/9090/9443) and the scheme is set to http — surfaces the most common fix-it case.

### Fixed
- **SQLite boolean robustness.** `buildContext` in `tunnel-config-writer.ts` used `.where({ enabled: true })` while the routes write `enabled: 1`. SQLite's behaviour here depends on Knex version + better-sqlite3 binding nuances. Switched to the explicit `.where('enabled', 1)` form which is unambiguous across all configurations. Now logs the host count per tunnel reload so config issues are visible in container logs.

### Changed
- `HostRow` in host-deploy.ts now carries `forward_scheme`, `forward_host`, `forward_port`, `tls_options` — needed by the new probe path.

---

## [0.1.3] — 2026-05-21

### Added
- **Retry-deploy button** for hosts in error state. A small orange refresh icon appears next to errored hosts; clicking it re-runs the deploy without deleting + recreating the host. Endpoint: `POST /api/hosts/:id/redeploy`.

### Changed
- **Cloudflare DNS errors are now human-readable.** The raw `403 {"success":false,"errors":[{"code":10000,...}]}` JSON dump that used to show up in the host's `last_error` field is replaced with actionable messages. Specifically:
  - `cf:10000` (Authentication error) → "Cloudflare rejected the DNS record write for `<host>`. Token is missing the 'Zone → DNS → Edit' permission on zone `<zoneId>`, OR the token's 'Zone Resources' scope excludes this zone. Fix it at dash.cloudflare.com/profile/api-tokens, then click Re-deploy."
  - `cf:81057` (record already exists) → "A DNS record for `<host>` already exists in Cloudflare. Delete the conflicting record from your CF dashboard, then click Re-deploy."
  - 401/403 (generic) → "Cloudflare rejected the DNS request: `<message>`. Verify the API token in Settings → Cloudflare."
- `CloudflareApiError` now carries a `cfErrorCode` field with Cloudflare's own numeric code, extracted from the SDK's `.errors[]` array. Future code paths can branch on this for finer-grained handling.

---

## [0.1.2] — 2026-05-21

### Added

- **Interactive update modal.** Clicking "Install update" now opens a full progress dialog instead of firing a toast and leaving the user blind:
  - **Real progress bar** with accurate stage-by-stage percentages (download = 50% weight, verify = 8%, apply = 30%). Download phase tracks live bytes-downloaded / total, including a human-readable byte counter (e.g. `1.4 MB / 12.7 MB`).
  - **9-stage list** with running spinner / done checkmark / pending circle per step (acquire lock → download tarball → download SHA → download GPG sig → verify SHA → verify GPG → spawn applier → apply → done).
  - **Collapsible terminal view** with live log lines from the backend during the download/verify phase, then the historical `/data/logs/update-history.log` tail after the apply finishes.
  - **Auto-reconnect on container restart**: when the SSE drops mid-update, the modal switches to a 2-second `/api/health` poll, interpolates progress 65→95 % via wall clock, and detects success by comparing the returned version to the starting version.
  - **Auto-reload to new frontend** with a 5-second countdown once the new backend is reachable.
  - **Rollback / failure detection** via the `.last-update-*.json` marker: shows the reason from `apply-update.sh` so the user understands what triggered the rollback.
- **`GET /api/updates/log?lines=N`** — tails `/data/logs/update-history.log` so the SPA can replay the apply phase after reconnect.
- **`GET /api/updates/last`** — returns the most recent `.last-update-*.json` marker for outcome detection.
- **New SSE topic `update.progress`** with fine-grained step + percent + download bytes.

### Changed
- `services/updater.ts` now tracks `step`, `step_label`, `overall_progress`, `download_bytes`, `download_total`, `started_at`, `target_version` on the status payload. All optional — older frontends ignore them.

---

## [0.1.1] — 2026-05-18

### Fixed

- **Tunnel creation crashed with `cf.zeroTrust.tunnels.create is not a function (TUNNEL_CREATE_FAILED)`.** The `cloudflare` npm SDK moved the `cfd_tunnel` endpoints under `.cloudflared` one level deeper. Tunnel create + delete now use the correct SDK path. ([8f5b987](https://github.com/Elias02345/CloudGate/commit/8f5b987))

---

## [0.1.0] — 2026-05-18

First user-facing release. Everything from M0 through M8 — `:latest` images now exist on GHCR and the one-liner installer picks them up.

### Added

#### M6 — Guided Onboarding + App-Tour
- Animated 6-step onboarding wizard with inline-SVG animations (welcome cloud, key glide, tunnel flow, server checkmark, spinner, confetti bounce) and Mantine `<Transition>` between steps
- NEW step 5 "Live verification": runs `/api/health/deep` and displays each subsystem with rotating spinner → green check or red ✗ with per-failure "fix this" hint
- 12-stop `react-joyride` spotlight tour across Dashboard / Hosts / Tunnels / Cloudflare / Settings / Audit / Updates / Donate with cross-page navigation
- DB-persisted user flags (`user.{id}.onboarding_completed_at` / `tour_completed_at` / `tour_dismissed`) so dismissal survives browser changes
- Settings → "Help & guided tour" card to replay the wizard or the tour at any time

#### M7 — Shell API for humans + AI agents
- Long-lived `cgk_<prefix>_<secret>` API keys with `admin` / `read` scope and optional expiry
- Unified auth middleware: `requireAuth` accepts JWT (SPA) OR API key (curl / scripts) transparently
- Per-key rate limit tier: 60 req/min admin · 120 req/min read, keyed on key id
- Conditional CORS: `Authorization: Bearer cgk_*` requests get `Access-Control-Allow-Origin: *`; browser cookie path stays same-origin
- New routes `GET/POST/DELETE/POST :id/rotate` under `/api/api-keys` (browser-only — keys can't manage keys)
- `GET /api/openapi.json` — OpenAPI 3.1 spec with 60s cache, served unauthenticated
- New frontend pages: `/api-keys` (Mantine table + create modal + shown-once plaintext display) and `/api-docs` (lightweight rendering of the live spec)
- `docs/AGENT.md` (~470 lines): quickstart, glossary, 7 numbered recipes with copy-paste curl (CF account + tunnel + host, bulk import, diagnose tunnel, ACME, encrypted backup, audit filter, health-recovery loop), full endpoint catalog, SSE topic list, error code table, safe-defaults checklist for autonomous agents

#### M8 — Optional in-app AI assistant
- Multi-provider: Anthropic (Claude), OpenAI, or any OpenAI-compatible base URL (OpenRouter, LMStudio, Ollama, vLLM)
- 3 user-configurable autonomy modes:
  - `off` (default) — feature disabled, FAB hidden, `/api/ai/chat` returns 503
  - `suggest_only` — AI reads freely, writes need a click-confirm
  - `autonomous` — AI may write directly; every action logged with `ai_initiated=true` in the audit log
- 9 read tools (list/get hosts, tunnels, audit, cf accounts, zones, health) + 4 write tools (create_host, toggle_host, delete_host, restart_tunnel). Tools call internal services directly — no HTTP round-trip
- Floating chat drawer (FAB bottom-right) with `react-markdown` + `remark-gfm` for tables, inline confirmation cards for suggest_only writes
- API key AES-256-GCM-encrypted via existing crypto service; never returned to the browser after save
- New routes under `/api/ai/`: settings, chat, conversations, confirm-action, settings/test
- New DB tables: `ai_conversations`, `ai_messages`, `ai_pending_actions` (5-min TTL for action tokens)

### Changed
- `GET /api/auth/me` now returns `{ user, flags }` (was: `{ user }`). Frontend handles both shapes transparently
- `globalLimiter` now skips API-key callers — they go through the per-key tier instead

### Migrations
- `20260518_002_api_keys` — new table
- `20260518_003_ai_conversations` — three new tables for AI feature (all opt-in, do nothing unless `llm.autonomy != 'off'`)

### Dependencies
- frontend: `react-joyride@^2.9`, `react-markdown@^9`, `remark-gfm@^4`
- backend: `@anthropic-ai/sdk@^0.32`, `openai@^4.77`

---

## [0.0.1] — pre-alpha

### Added

#### M0 — Foundation
- pnpm monorepo skeleton with `backend`, `frontend`, `recovery-ui`, `shared` packages
- Zero-config Docker image (multi-stage: Node 22 + nginx + cloudflared + s6-overlay + gpg + sqlite3)
- Idempotent bootstrap: auto-generates encryption key, JWT secret, admin password on first run
- Recovery UI fallback served when the main backend cannot start
- One-liner Ubuntu/LXC installer (`install/lxc-install.sh`) with image-fallback + source-build path
- GitHub Actions: `ci.yml`, `release.yml` (GPG-signed multi-arch), `nightly.yml`
- `CLAUDE.md` + `docs/UPDATE_RULES.md`: persistence contract for contributors
- `TODO_FOR_USER.md`: living doc of manual steps awaiting Elias' hardware test

#### M1 — Core MVP
- Auth: Login + JWT (jose, HS256) + Argon2id passwords + force-password-change on first login
- Rate limiting on `/auth/login` (5/15min) + global 300/min
- Cloudflare integration: API token validation, account CRUD with AES-256-GCM encrypted storage, zone sync
- Tunnel lifecycle: cloudflared spawn with exponential backoff, SIGHUP reload, health-poll, ring-buffer logs
- Proxy hosts: full CRUD with CF DNS CNAME creation + tunnel-config reload
- SSE event bus for live UI updates
- React 19 + Vite + Mantine v7 + TanStack Query + react-i18next (DE + EN)

#### M2 — UI Polish
- Dashboard with 4 live-count stat cards + click-through links
- Settings page: language switcher, theme toggle (light/dark/auto), profile, About
- Top-level `ErrorBoundary` (no blank-page crashes)
- Loading skeletons, empty states, toast notifications

#### M3 — Hybrid Mode
- `local_nginx` host mode: per-host nginx conf with atomic-write + `nginx -t` validation
- ACME / Let's Encrypt integration via `acme-client` (DNS-01 challenge through user's CF account)
- Auto-renewal cron: 24h check, renews certs with <30 days left
- "Issue cert" button in UI for local_nginx hosts

#### M4 — Production
- 2FA TOTP: QR-code setup, login-time verification, password-protected disable
- Encrypted backup: AES-256-GCM + PBKDF2 (200k iterations), tar.gz inside, `.cgbk` extension
- Audit log: paginated UI with color-coded action badges, filter support
- Audit writes wired into login, totp.{enabled,disabled}, backup.exported, update.* events

#### M5 — Auto-Update
- `services/updater.ts`: 6h GitHub-release polling, channel filter (stable/prerelease/nightly/disabled)
- Optional GPG signature verification (graceful warning when unsigned)
- Optional SHA256 integrity check
- `docker/apply-update.sh`: paranoid in-container applier with snapshot+swap+migrate+health-check+rollback
- Update UI with channel + mode (notify/auto/scheduled) selectors

### Security
- AES-256-GCM at rest for Cloudflare tokens, OAuth credentials, TOTP secrets, tunnel secrets
- Argon2id for password hashing
- JWT with HS256 signing (separate `jwt.key` rotated independently from `encryption.key`)
- Helmet for HTTP security headers (CSP enabled in next release)
- Per-route rate limiting

## [0.0.1] — initial scaffold

First commit on `dev`. Not functional — repository structure only.
