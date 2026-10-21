# Identity and Visitor Manager: plan

One directory of tenants (companies and their people) and of visitors, across one or more
buildings, with an iPad kiosk in each lobby where visitors check themselves in and out. The
Equipment Checkout system reads its borrowers from this directory instead of keeping its own
list.

## Decisions

| Question | Answer |
|---|---|
| Stack | Same as Equipment Checkout and the DMARC analyzer: Node 24, Express 5, vanilla front end, SQLite. Sign-in code carried over from Checkout (local accounts with password, authenticator code and passkeys, plus Microsoft Entra ID). |
| Encryption | The whole database file is encrypted (SQLCipher, AES-256) with a key kept outside the data volume. Users, sessions, settings, logos and secrets live in the encrypted database too, not in JSON files. |
| Sites | Several buildings in one installation. Each site has its own name, logo, time zone and end-of-day time. A company can be at more than one site. With a single site, the site pickers are hidden. |
| Who sees what | Every field, built-in or custom, has an access level per role: hidden, view or edit. The server removes hidden fields before anything leaves it. Staff accounts can also be limited to some sites. |
| Custom fields | Defined per record type (company, person, visitor). A field is either database-wide (every record of that type has it) or belongs to one record. |
| Visitors | Kept apart from tenant people. A visitor can be linked to any number of companies, each with a usual point of contact. |
| Kiosk | A separate, minimal page set at `/kiosk`, signed in as an enrolled device that belongs to one site. It can only look up a name, check in and check out. |
| Equipment Checkout | Reads companies and people through an API key and keeps a local copy it refreshes every few minutes, so it keeps working if this system is down. Adding a person at the Checkout desk creates them here through the API. Which fields it receives, and which sites, are set in Settings. |
| Host notification | Not in the first version. The front desk sees arrivals on screen. |
| Hosting | Docker behind Nginx Proxy Manager, like Checkout (Let's Encrypt at NPM, self-signed between NPM and the container). |

## Architecture

```
iPad kiosks, one or more per site      Staff browsers      Equipment Checkout server(s)
        │ device token                     │ user session        │ API key
        └──────────────── HTTPS (Let's Encrypt at NPM) ──────────┘
                                   │ HTTPS (self-signed)
               Identity and Visitor Manager container (Node 24 + Express 5)
                 ├─ SQLCipher database: sites, directory, visitors, visits, custom
                 │  fields, roles and field policies, users, sessions, devices,
                 │  API clients, settings, logos, audit
                 ├─ database key: Docker secret (DB_KEY_FILE), never in the data volume
                 └─ outbound: login.microsoftonline.com (Entra)
```

## Encryption

- **At rest.** The database is opened with SQLCipher through `better-sqlite3-multiple-ciphers`
  (a drop-in for better-sqlite3). Every page of the file, and of its WAL file, is encrypted
  with AES-256 and authenticated with HMAC-SHA512. Temporary tables stay in memory
  (`temp_store = MEMORY`) so nothing unencrypted lands on disk. Site logos are stored in the
  database, not as files, so they are covered too.
- **Key.** A random 256-bit key, made with `npm run new-key`, given to the container as a
  Docker secret. The app refuses to start without it, and refuses to open an existing file
  with the wrong one. Lose the key and the data is gone, so it goes in the password manager
  on day one. `npm run rekey` changes it.
- **Backups.** A backup is a copy of the encrypted file, so it stays encrypted. CSV exports
  are plain text by nature: admins only, and every export is in the audit log.
- **In transit.** HTTPS on every hop, including Checkout → this system.
- **What it does not do.** Whole-file encryption protects a stolen disk, volume, VM snapshot
  or backup. It does not hide data from someone using the running app; that is the job of
  roles and field policies. Encrypting chosen fields a second time with a separate key was
  considered and dropped (decided 2026-10-13: whole-file encryption only).

## Sites

A site is a building (or a campus treated as one front desk).

- **Settings → Sites**: name, address, time zone, the name shown on the kiosk (defaults to
  the site name), logo image (PNG, JPEG or SVG, resized on upload), optional welcome line,
  end-of-day check-out time (or off), active.
- The first start creates one site. Until a second one exists, nothing in the interface asks
  which site.
- **Companies** are placed at one or more sites, with a suite/floor per site.
- **People** can be tied to one of their company's sites, or left as "any site".
- **Kiosks** belong to one site. A kiosk shows that site's name and logo, offers only the
  companies at that site, and only hosts who work there (or at "any site").
- **Visits** record the site, so "in the building now", the evacuation list and the
  end-of-day check-out all work per site.
- **Staff accounts** see all sites unless an admin limits them to some. A front-desk account
  limited to one site sees only that site's visitors in the building, visit log and kiosks.
  The directory itself is shared: a limited account still sees companies at its sites only.
- **Equipment Checkout**: each Checkout installation has its own API client, limited to the
  sites it serves, so it receives only the companies (and their people) at those sites.

## Data model

- **sites**: name, address, time zone, kiosk name, logo, welcome line, end-of-day time,
  active
- **companies**: name, main phone, email, website, address, notes, active
- **company_sites**: company ↔ site, with suite/floor
- **people**: company, site (or any), first and last name, preferred name, job title, email,
  work phone, mobile, can host visitors (yes/no), notes, active. People who leave are made
  inactive, never deleted, so Checkout's loan history keeps a name.
- **visitors**: first and last name, email, phone, their own organisation, notes,
  verified (staff have reviewed a kiosk self-registration), blocked, last visit
- **visitor_links**: visitor ↔ company, with the usual point of contact (a person in that
  company) and notes. A visitor can have any number.
- **visits**: site, visitor, company visited, host, purpose, checked in at, checked out at,
  how it ended (self at kiosk, staff, end-of-day automatic), kiosk device
- **field_definitions**: record type, label, key, type (text, long text, number, date,
  yes/no, choice list, email, phone), choices, required, scope (database-wide or one
  record), default access per role
- **field_values**: definition, record, value
- **roles** and **field_policies**: role × record type × field → hidden / view / edit
- **users** (with their sites, or all), **sessions**, **kiosk_devices** (with their site),
  **api_clients** (with their sites, role and write permission), **settings**, **audit**

## Settings

Everything the front desk might want to change is in Settings (admins only), nothing in
environment variables except the database key and network setup:

| Page | What it holds |
|---|---|
| Sites | Per site: name, kiosk name, logo, welcome line, address, time zone, end-of-day check-out time |
| Visits | How many months of visits to keep (off = keep forever); applies to all sites |
| Kiosks | Enrol, rename, move to another site, revoke; idle time before the kiosk resets |
| Fields | Custom fields for companies, people and visitors |
| Field access | The role × field grid |
| API clients | Keys, their role, their sites, write allowed, and the fields they receive |
| Users | Accounts, roles, the sites each can see; Entra ID sign-in |
| Audit log | Every change, by whom, from where |

**End of day.** A clock check every minute: once a site's end-of-day time passes in that
site's time zone, its open visits are closed and marked "checked out automatically". Visits
still open from an earlier day (say the server was down at the time) are closed on the next
check.

**Retention.** Once a day, visits older than the set number of months are deleted, and so
are self-registered visitors who were never verified and have no remaining visits. Changing
the setting shows how many visits would go before it is saved.

## Custom fields

Admins add them under Settings → Fields, or from a record ("Add a field to this company
only"). A database-wide field shows on every record of its type, can be required, and can be
searched and filtered. A one-record field shows only on that record. A one-record field can be
promoted to database-wide later, keeping its value.

## Roles and field visibility

Built-in roles, plus any the admin adds:

- **Admin**: everything, always, including settings, users and field policies
- **Manager**: edit companies, people and visitors
- **Front desk**: manage visitors and visits, read the directory
- **Viewer**: read only
- **Kiosk** (devices) and **Equipment Checkout** (API clients): roles like any other, so the
  same matrix decides what they receive

Settings → Field access shows a grid: one row per field, one column per role, each cell
hidden / view / edit. Names can't be hidden from any role that can see the record at all.

Enforcement is in one server-side function that every response goes through: the staff
pages, the kiosk, the API, CSV exports and search. It applies both limits: which sites the
caller can see, then which fields. Search ignores fields the caller can't see, otherwise
"search by salary" would leak salaries. Edits that touch a field the caller can't edit are
refused. The tests for this function are the most important ones in the project.

## Visitors (staff side)

- **Visitors**: search, add, edit, merge duplicates; each visitor's companies with their usual
  host, and their visit history
- **In the building now**: everyone checked in at the chosen site, with check-out buttons and
  a print-friendly evacuation list
- **To review**: visitors who registered themselves at a kiosk, for staff to confirm,
  correct or merge
- **Visit log**: filters by site, date, company, host and visitor; CSV export

## Kiosk

Large type, one question per screen, no menus, and back to the start after a set idle time
(45 seconds by default). Built for an iPad in Guided Access, in either orientation.

1. **Welcome.** The site's logo and kiosk name, one box ("Your name"), and two buttons:
   **Check in** and **Check out**.
2. **Found you.** "Welcome back, Jane." The company she is visiting and her host. **Check
   in** or **Something's different**. A visitor linked to several companies at this site
   taps the one she is visiting today.
3. **New here.** Name (already filled), your company, email or phone, the company you are
   visiting (searchable list of this site's tenants), your host (that company's hosts at this
   site, or "I'm not sure"), then **Check in**.
4. **Done.** "You're checked in. Take a seat and the front desk will let Bob know you're
   here." Then back to the start.

Check out: name → "Check out Jane Doe, visiting Acme?" → done. Only visits open at this site
are offered.

Name matching ignores case, accents, extra spaces and punctuation, accepts the names in either
order, and tolerates one typo per name. It only answers to a full name (first and last), so a
passer-by can't type "J" and browse the visitor list. Two visitors with the same name are told
apart by the company they visit, nothing more.

The kiosk only ever shows what a visitor already knows: their own name, the company they
visit, their host's name. Never email, phone or history. Lookups are rate-limited per device.

**Enrolment.** An admin adds a kiosk under Settings → Kiosks, picks its site and gets a
one-time pairing code; the iPad opens `/kiosk`, enters the code and keeps a long-lived device
token. Kiosks can be moved to another site or revoked at any time. Kiosk visitors are created
as unverified and land in the review list. A logo or name change shows on the kiosk at its
next return to the welcome screen.

## Equipment Checkout integration

This system:

- `GET /api/v1/companies` and `GET /api/v1/people`, with `?updated_since=` for incremental
  sync and `?q=` for search; each client gets only its sites and its fields
- `POST /api/v1/people` (only for API clients allowed to write; Checkout's key is, so its
  "Add person" creates the person here and then refreshes its copy)
- Settings → API clients: name, sites, write allowed, last used, and a checklist of the fields
  it receives (name is always included; proposed starting set: job title, email, phone,
  company). The checklist is the client role's column of the field access grid, shown where
  it's easiest to find. Keys are shown once and stored hashed.

Equipment Checkout (changes in `D:\Codex\Check-in Check-out`):

- Settings → Directory: **Local** (as now) or **Identity and Visitor Manager** (URL, API key,
  certificate fingerprint for the self-signed hop if it calls the container directly)
- In directory mode its `tenants` and `people` tables become a read-only copy, keyed by a new
  `external_id` column, refreshed every 5 minutes and on demand ("Refresh now"). Fields the
  key no longer receives are cleared from the copy at the next refresh.
- Loans keep pointing at the local copy, so history survives anything that happens upstream;
  people removed upstream (or no longer at Checkout's sites) are marked inactive locally, and
  anyone with items still out is flagged
- One-time move: an import of Checkout's current tenants and people into this system, at a
  chosen site, matched by name and email, with the new IDs written back

## Phases

1. **Foundation.** Project from Checkout's skeleton (auth, Entra, TLS, Dockerfile, audit),
   SQLCipher with key handling, sites, companies and people, custom fields, roles, site
   limits and the field access grid, CSV import/export.
   **Built 2026-10-13**, with an encrypted backup download added. 4 test suites
   (`npm test`). Choices made while building it:
   - Accounts, sessions and Entra settings are JSON documents in the encrypted database
     (the `documents` table), so the sign-in code stays the same as Checkout's.
   - A custom field with no cell in the grid is hidden (fails closed). Writing a field
     hidden from you is answered "there is no such field", so its existence isn't revealed.
   - Logos are turned into PNG in the browser before upload; the server accepts only PNG
     and JPEG, so it never serves SVG.
   - CSV imports skip columns for fields the importer can't change, and list them.
   - A company's people count, for a site-limited account, counts only people it can see.
   - Not tried yet: the Docker image build, Entra against a real tenant, passkeys on a device.
2. **Visitors.** Visitor records and links, visits, the staff pages above, the kiosk with
   device enrolment, end-of-day check-out and retention.
   **Built 2026-10-13.** 6 test suites, 360 checks. Choices made while building it:
   - Visitors are a third record type in the field access grid (built-in and custom
     fields), governed by each role's visitor access rather than its directory access.
   - The kiosk has no column in the grid: it only ever shows names (the decision that the
     kiosk shows the company and host only), so a column there could not change anything.
   - Kiosk lookups hand back short-lived references, not record ids; 30 lookups a minute per
     kiosk; 10 wrong pairing codes per address per 15 minutes. The device cookie is
     HttpOnly, SameSite=Strict, limited to /kiosk, and kiosk POSTs need a custom header.
   - A blocked visitor is sent to reception by the kiosk (no visit is made, the attempt is
     audited); the desk can let them in only by ticking that a manager agreed.
   - A visitor's email or phone is optional at the kiosk, to keep check-in quick.
   - Visits keep a copy of the company's and host's names, so the log reads correctly after
     either is removed. Retention never deletes a visit still open.
   - The header's site picker had shown no sites since phase 1 (a DOM append of an array);
     fixed.
3. **Checkout link.** The API and API clients here; directory mode, sync and the one-time
   import in Checkout.
   **Built 2026-10-13.** 7 suites here (api.test.js added), 8 in Checkout
   (directory.test.js runs a real Identity Manager over pinned TLS). Choices made:
   - Each API client has its own role (kind "api", "API: <name>"), so its own column of
     fields; the built-in Equipment Checkout role is the template new ones copy. Writing
     clients may set the fields they receive. Their roles are managed only from Settings >
     API clients.
   - One `/api/v1/sync?since=` call gives changes plus the ids of everyone visible, so a
     client can tell who has gone (deleted, moved site, company out of reach); a fields
     version tells it to fetch everything again when its fields change.
   - Checkout links existing tenants by name and people by email (else name) in the same
     company on the first sync, so loans and card codes carry over. Gone people are made
     inactive and marked, never deleted. Card codes and notes stay local.
   - Pinning: Checkout opens the TLS connection itself and checks the SHA-256 fingerprint
     before writing anything, then sends the request over that socket.
4. **Later.** Host notification (email, then Teams), expected visitors (pre-registration by
   hosts), badge printing, photo at check-in, NDA or site rules signed at check-in, a
   blocked-visitor alert to the front desk, reports.

## Badges, clearances and expected visitors (2026-10-14)

Asked for after the three phases. Decisions: levels rank Secret < TS < TS//SCI < TS//SCI CI <
TS//SCI FSP (FSP covers CI; the user corrected FCP to FSP); "personnel" means building staff
(a company flag); visitors carry clearances too; visitor badges stay out until taken back.
Built: clearance.js, badges.js, events.js, badge-routes.js, schema 4 (badges, assignments,
levels, classifications, events, guests; building_staff, clearance columns, roles.badges),
a badges area on roles, the Badges and Expected pages, Settings > Badges and clearances.
Later the same day the user asked for badges valid at several sites and given across sites:
a badge lists the sites it is valid at (badge_sites; none = every site) and anyone may hold
it whatever site they work at. Temporary badges (2026-10-14, asked for by the user): badges.temporary marks a stock lent for
the day; a temporary loan goes only to a person holding a regular badge, records
replaces_badge_id and due_at (midnight in their site's time zone), one at a time; overdue
loans are counted, never returned automatically. The old "Badge number" custom field was
removed from the demo data and the seed. Choices made while building it: someone holding a badge can't be deleted; adding a new event guest whose name is already on
record asks first; clearance fields start hidden from read-only roles and API clients.

## Clearance validation (2026-10-14)

Asked for by the user: a validation tag on each person, a Request validation button that can
take the last four of the SSN into a queue only the Security role sees, the digits never
stored or logged and wiped on validation; only Security assigns clearances; visitors
re-checked every 90 days, adjustable in Settings. Built: a built-in Security role (reads
directory, visitors and badges); clearance fields flagged `security` are capped at read-only
for every role, administrators included, and setPolicies refuses edit on them;
clearance_requests (schema 5, no digit column) and people/visitors clearance_validated_at/by;
clearance.js holds the digits in a Map of Buffers (zero-filled on wipe, 36-hour lifetime from
CLEARANCE_DIGITS_HOURS, never a JavaScript string: the request body is read raw and the digits
copied out before JSON parsing, the answer to Security written as bytes with no ETag;
swept every 10 minutes and against closed requests), clearance-routes.js (Cache-Control
no-store; the queue never carries digits, POST .../digits returns one request's), the
Clearances page (public/js/17-clearance.js). Choices made while building it: only a
validated clearance counts for badges (existing clearances need validating); Security may
also ask for validation; an administrator account can't validate (an account has one role,
so Security is a separate account); the re-check period is an administrator setting; a
request waiting keeps a kiosk-registered visitor from the retention clean-up; a restart
wipes the digits (by design: they live only in memory).

## Database key sealed to the TPM (2026-10-14)

Asked for by the user as an option. deploy/tpm/: setup.sh (check, seal, install, status,
uninstall), identity-visitor-manager.service.in (LoadCredentialEncrypted from
/etc/identity-visitor-manager/db_key.cred; the key copied into /run/identity-visitor-manager
owned by uid 1000 since systemd's copy is root's; docker compose up in the foreground with
Restart=always), docker-compose.tpm.yml (restart "no"; the db_key secret from /run). Default
PCR 7; `--pcrs none` for the chip alone. The plain-file setup stays the default.
Same day the user asked for a compose file as simple as the DMARC tool's: a fresh install now
makes its own key (DB_KEY_CREATE) in an identity-keys volume of its own, separate from
identity-data, so `docker compose up -d` is all a first start needs; optional settings come
from an optional .env (env_file). The TPM override replaces /keys with an empty tmpfs, and
setup.sh seal reads the key straight from the volume.

## Badge images and who sees clearance levels (2026-10-14)

Asked for by the user: a tenant and a visitor badge image per clearance level, shown to the
front desk when giving a badge out, with clearance level names shown only to authorised
roles (Security, Managers, Administrators). User decisions: images per level plus a pair for
uncleared badges, personnel badges use the tenant image; a per-role "Sees clearance levels"
switch (roles.clearances, schema 6), on for admin, manager and security (security always);
front desk picks a cleared badge's level by its image (templateRef, never a level id); the
large "Give them this badge" image plus thumbnails. Built: badge-templates.js (badge_templates,
keyed by level and kind, random ref per upload), templates in badge-routes.js (badgeOut strips
level ids and names, levelInput, suggested), the sensitive-field cap in access.levelFor and
setPolicies, level-free refusal messages, Settings > Badges and clearances > Badge images.
Choice made while building it: the large image is of the highest badge actually on offer to
them, not of their own level, so it always matches a badge in the list.

## Kiosk visitors waiting for a badge (2026-10-14)

Asked for by the user: when a visitor checks in at the kiosk, a banner on the admin pages of
users at that site saying a badge needs assigning, with a button to start it. Built:
badges.waitingForBadge / waiveVisitBadge (open visits with a kiosk_id whose visitor holds no
badge, not waived; visits.badge_waived_at/by, schema 7), GET /api/visits/badge-needed and POST
/api/visits/:id/badge-not-needed (visitors read + badges edit, site-limited), ?site= on
/api/badge-holders, public/js/18-badge-alerts.js (15-second poll, at most three banners then
"N more"). Choices made while building it: shown only to staff who can give badges out (a
banner they can't act on would be noise); a "No badge needed" button so an escorted visitor
doesn't keep it up all day; staff check-ins never raise it (the desk dialog already offers
a badge).

## Sections, Home and site switching (2026-10-21)

Asked for by the user: the Settings tabs didn't fit (Audit was cut off); a top menu of
categories (Tenants, Visitors, Security, Settings), Security only for the Security role and
administrators; a dashboard on sign-in with modules each person adds (tenants, expected
visitors, for Security the clearance queue and re-checks); and quick switching between the
sites someone can see. User decisions: Badges appear under Tenants, Visitors and Security, and
only Security configures and edits badges (others issue and return): badge access gained a
"manage" level (BADGE_LEVELS; Security and Administrator, migrated once); administrators see
everything under Security except the queue; each person arranges their own dashboard. Built:
SECTIONS and a second nav row (13-app.js), the site switcher (setSite, kept server-side in
prefs.js as prefs.<user id> documents, with the dashboard), Home (19-dashboard.js, ten
modules, Customize with up/down/remove/add), Security > Re-checks and expiry
(clearance.overview, /api/clearance/overview), a grouped Settings side menu. Choices made
while building it: administrators keep full badge access as everywhere else; the app's name
hides below 1180 px so the sections fit an iPad in landscape.

## Importing from Access, with column matching (2026-10-21)

Asked for by the user: import an Access database directly, with a step that matches its
columns to the app's fields. Built: mdb-reader 3.2.0 (MIT, pure JavaScript, reads .accdb and
.mdb, no Access or ODBC needed; ES module loaded with import()), import-routes.js (read a file
into memory per account for 15 minutes, a table's sample, run with a mapping of field ->
column or fixed value), importPeople and importCompanies factored out of the CSV routes in
server.js so both paths share the same checks, public/js/20-import.js (the wizard, used for CSV
too), test/import.test.js with test/fixtures/directory.mdb. Choices made while building it: the
file is parsed on the server (no bundler for a browser build) but never written to disk; one
held file per account and four at once; companies can take a site and a suite as separate
columns. Only the Jet (.mdb) format is tested here: the development machine has no ACE engine
to make an .accdb. Same day the user asked for visitors and badges too: importVisitors
(visitors.findMatch by email, else exact name; company and host by name; source "import",
verified) and importBadges (badges.findByNumber; type, classification and level by name;
level only for roles that see clearance levels) in server.js; each target has its own
permission in import-routes.js (people/companies directory edit, visitors visitor edit,
badges manage), and reading a file needs any of them.

## Several at once: merging companies, bulk changes (2026-10-21)

Asked for by the user: choose several companies to delete or merge, choosing which to keep
and editing things such as its name while merging; bulk edit people (delete, inactive, other
fields, custom fields). Built: directory.mergeCompanies (people, visitor_links with the kept
company's link winning, visits, visitor_events and record-only fields move; the others are
deleted before the kept one is updated, so it can take a merged one's name; sites default to
the union), routes /api/companies/merge, /api/companies/bulk, /api/companies/bulk-delete,
/api/people/bulk, /api/people/bulk-delete (bulk: no names; all or nothing via importRows with
"changed" wording; deletes admin-only and refused while anyone holds a badge),
public/js/21-bulk.js. Choices made while building it: merge needs directory change (managers
can), as it loses no people; bulk edit leaves out names and email.

## Several badges at once, and light or dark (2026-10-21)

Asked for by the user: the same choosing-several for badges, including moving badges between
visitor, tenant and personnel; and a switch between dark and light (it only followed the
device, which here is dark). Built: /api/badges/bulk and /api/badges/bulk-delete (manage;
all or nothing through the transaction now passed to badge-routes; level by image for roles
without clearance levels via levelInput), tick boxes and Change/Retire/Delete on the Badges
page (21-bulk.js); public/js/00-theme.js in <head> (data-theme on <html>, localStorage, no
inline script because of the CSP), the dark palette under :root[data-theme=dark] and under the
device media query unless data-theme=light, a header button, Account > Appearance, and theme
in prefs.js. The kiosk keeps its own look.

## Custom badge fields (2026-10-21)

Asked for by the user: custom fields on badges, like those on companies, people and visitors.
Built: "badge" is a fourth entity in catalog.js (governed by the badges area, with no built-in
fields); editsArea() makes the manage level, not edit, the one that changes them, so only
Security and Administrator change badge fields, and the grid refuses "Can change" for roles
that only issue badges. badge-routes writes custom values on add, range, edit and bulk change
(patch.custom), checks required ones on add, and forgets them when a badge is deleted; the
badge import maps custom columns. Front end: Settings > Fields "Badge fields", a Badges table
in Field access, the badge forms and dialog, Change for several, and the import.

## Facilities (2026-10-21)

Asked for by the user: floor layouts showing which offices are taken or available, assigning
offices to companies, each office's size in square feet and a cost per square foot managed
per office and per company, limited to managers or a custom role. Decided with the user: an
uploaded floor plan image with offices drawn on it as rectangles; the company's rate wins over
the office's; rates are per month; assignments have start and end dates and keep history.

Built (schema 8): floors (site, name, order, plan image with a random ref), offices (floor,
name, sq ft, own rate, unavailable, x/y/w/h as fractions of the plan, notes),
office_assignments (company id and name, start and end date as YYYY-MM-DD at the site, end
inclusive, notes, who and when), site_rates and company_rates; roles.facilities (none, read,
edit; Administrator and Manager edit, seeded once). facilities.js: effective rate company >
office > site, monthly = sq ft × rate, status by today at the site, no overlapping
assignments, a floor or office that is assigned now or later can't be deleted, nor can a
company; mergeCompanies moves assignments. facility-routes.js; public/js/22-facilities.js
(Floor plans with drawing, moving and resizing by pointer events, Offices, Rates, the office
dialog, the panel on a company's page); an Offices module on Home. Choices made while building
it: one currency (US dollars); a company rate applies at every site; rates are current, not
dated (an ended assignment shows no cost); plans up to 2.75 MB, re-encoded in the browser.

Then (same day, asked for by the user): offices of any shape, outlined point by point, with
points added, moved and removed afterwards; and a scale step that measures each office from its
outline. The user asked that square feet still be entered by hand: the measurement only
suggests (pre-fills a new office, shows beside the entered size, fills in missing ones on
request) and never overwrites. Built: offices.points (JSON [x, y] fractions; x/y/w/h kept as
the box around it; rectangles drawn before read as their 4 corners), floors.plan_width and
plan_height (read from the PNG or JPEG header, backfilled), scale_feet (feet across the plan's
full width) and scale_line, PUT /api/floors/:id/scale, measuredSqft on offices (shoelace area x
scale_feet^2 x height/width). The plan is drawn as SVG polygons (viewBox 0 0 1 1, stretched,
non-scaling strokes) with HTML labels at the point inside each outline farthest from its edges.

## Tests

- Field projection: every role × every field type, with and without site limits, on records,
  lists, search, exports and the API
- Encryption: the database file contains none of the seeded names or logo bytes; the wrong
  key fails to open it; rekey round-trip
- Sites: a kiosk sees only its site's companies, hosts and open visits; end-of-day check-out
  in two time zones, including across a daylight-saving change; a site-limited account can't
  reach another site's visits by ID
- Retention: only visits past the cut-off go, and the preview count matches
- Name matching: order, accents, typos, partial names refused, duplicates
- Kiosk flow end to end in Playwright at iPad sizes, plus device revocation and moving a
  kiosk to another site
- Checkout sync against a running instance of this system, including a field being removed
  from its checklist

## Assumptions (say if any are wrong)

- A company can be at several sites; a visitor's link to a company covers all its sites.
- Visit retention is one setting for all sites; end-of-day time is per site, since sites may
  be in different time zones.
- Field access is the same at every site; only which records a person sees varies by site.
- Custom fields are shared by all sites.
