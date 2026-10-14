# Identity and Visitor Manager

A directory of the companies in one or more buildings and the people who work for them,
and of their visitors, kept in an encrypted database, with control over which fields each
role can see. Visitors check themselves in and out on an iPad kiosk in each lobby. The link
to Equipment Checkout comes in phase 3 (see [PLAN.md](PLAN.md)).

## The directory

- **Sites.** One or more buildings, each with its own name and logo (for its kiosk), time
  zone and end-of-day check-out time. With a single site, nothing asks which.
- **Companies** with contact details, placed at one or more sites with a suite or floor at each.
- **People** in a company: names, job title, email, phones, the site they work at, whether they
  can host visitors.
- **Custom fields** for companies and people: text, long text, number, date, yes/no, choice
  list, email, phone, web address. A field is either on every record (and can be required) or
  added to one record only, and can later be made a field for every record.
- **Field access.** A grid of roles × fields, each cell hidden, read only or can change. The
  server leaves hidden fields out of every response, CSV export and search: searching for a
  value in a field you can't see finds nothing.
- **Roles.** Administrator, Manager, Front desk, Viewer, and any you add. Each role reaches
  the directory and visitors separately (none, read, or read and change). Equipment
  Checkout has a column in the grid already, for phase 3.
- **Site limits.** An account can be limited to some sites. It then sees only the companies at
  those sites, and their people who work there (or at any site).
- **Encryption.** The whole database is encrypted with SQLCipher (AES-256, with HMAC-SHA512
  page authentication), including its WAL file, accounts, sessions, settings and logos.
  The key is kept outside the data directory.
- **Sign-in** carried over from Equipment Checkout: local accounts with password, authenticator
  code and passkeys, plus Microsoft Entra ID. App roles in Entra match role names (`Manager`,
  `FrontDesk`, ...).
- **CSV import and export**, an **encrypted backup download** and an **audit log** that
  records which fields changed, never their values.

## Visitors

- **Visitors** are kept apart from tenant people. Each can be linked to any number of
  companies, with a usual host at each. They have their own fields in the field access grid,
  custom fields included, governed by each role's visitor access.
- **In the building** lists everyone checked in (per site, with the header's site picker),
  with check-out buttons, a desk check-in, and a print-friendly evacuation list.
- **Visitors** lists everyone, with those who registered themselves at a kiosk marked "To
  check": staff confirm them, correct them, or merge them into an existing visitor. A visitor
  can be blocked: the kiosk then sends them to reception, and the desk needs a manager's say-so.
- **Visit log**: every visit with filters and a CSV export (administrators).
- **End of day**: at each site's end-of-day time, in its own time zone, anyone still checked
  in is checked out automatically, at that time, even if the server was down then.
- **Retention**: Settings > Visits sets how many months of visits to keep (off by default),
  with a count of what a change would delete before you save it.

## Badges and clearances

- **Badges** have a number, a type (personnel, tenant or visitor), a classification and, when
  the classification needs one, a clearance level; and the sites it is valid at (any number,
  or every site). Add them one at a time
  or as a numbered range (B-0001 to B-0050). Statuses: active, lost, retired.
- **Who may hold what.** Personnel badges go to people of companies marked **Building
  staff**, tenant badges to everyone else's people, visitor badges to visitors. A badge with
  a clearance level goes only to someone whose clearance covers it. A badge can be given to
  anyone, whatever site they work at. The app refuses anything else, whoever asks. Staff
  limited to some sites see the badges valid at any of their sites.
- **Clearance levels** are an ordered list under Settings > Badges and clearances: Secret <
  TS < TS//SCI < TS//SCI CI < TS//SCI FSP to start with; a higher level covers every level
  below it. **Classifications** (Cleared, Uncleared, and any you add) say whether a badge
  carries a level.
- **People and visitors** have a clearance level, the date it was granted and when it
  expires; an expired clearance counts as none. Clearance fields go through the field access
  grid and start hidden from roles that only read the directory (or visitors) and from API
  clients, but nobody can change them in a record, administrators included.
- **Validation.** Only the **Security** role sets a clearance, by validating it, and only a
  validated clearance counts for badges. Every person and visitor carries a tag: Not
  validated, Validation requested, Validated, or (visitors) Re-check due. Anyone who may
  change the record asks with **Request validation** on its dialog, optionally giving the
  last four of the person's SSN. Security works through the **Clearances** page (only
  Security sees it), shows the digits when needed (one request at a time, for 30 seconds),
  chooses the level and validates. The digits are held in the server's memory only: never in
  the database, a log, the audit trail or a URL, and wiped when Security validates or
  cancels, when the person is deleted, after 36 hours (`CLEARANCE_DIGITS_HOURS`, up to 168), or when the server stops (a restart
  loses them, and the request then shows "Wiped"; ask again). The audit trail records that
  digits were given or viewed, never what they were.
- **Visitor re-checks.** A visitor's validation lasts 90 days, then shows Re-check due and
  counts as none until Security validates it again. Change the period under Settings >
  Badges and clearances. People's validations don't lapse; their clearance's expiry date
  still applies.
- **History.** Every assignment is kept: to whom, when, by whom, and when and how it came back
  (returned or lost). Visitor badges stay out until someone takes them back; the Badges page
  and In the building show those still out with visitors who have left. Someone who holds a
  badge can't be deleted until it comes back.
- **Temporary badges.** A badge can be marked temporary: a stock kept at the desk for people
  who forgot theirs. One goes only to a person who holds a badge of their own ("Forgot their
  badge today?" on their dialog), records which badge it stands in for, and is due back by
  midnight where they work. Their own badge stays theirs. One not back in time shows as
  overdue on the Badges page and in the navigation until someone takes it back.
- **Access.** Each role has a badge level as well as directory and visitor levels: read to
  look, change to add badges and give them out. Front desk can change badges by default.

## Expected visitors

**Expected** lists a day's visitor events: a name, time, site, company and host, and the guests
expected. Each guest shows as expected, here (since when) or left. Guests are picked from
visitors on record or added as new ones (the app says when someone of that name is already
on record), and are linked to the event's company and host, so the kiosk recognises them.
At the kiosk an expected guest is offered their event's company and host first; checking
in, at the kiosk or the desk, marks them arrived. The navigation counts guests expected
today who haven't arrived.

## The kiosk

An iPad in Safari at the kiosk address, saved to the Home Screen and locked with Guided
Access.

**Its own port.** With `KIOSK_PORT` set (docker-compose sets 3001), the kiosk has a port of its
own that serves the kiosk page and its API and nothing else: no staff pages, no staff
sign-in, no `/api`. The main port then has no `/kiosk` at all. In Nginx Proxy Manager give
each its own host (say `visitors.example.com` to port 3001, `directory.example.com` to
3000), set `KIOSK_URL=https://visitors.example.com` so Settings > Kiosks shows the right
address, and keep port 3000 off the lobby network. Without `KIOSK_PORT`, the kiosk is at
`/kiosk/` on the main port.
 Settings > Kiosks adds one for a site and gives a one-time pairing code; the
iPad keeps a device token. A new code, or removing the kiosk, signs the iPad out at once.

1. **Welcome**: the site's logo and name, one box for the visitor's full name, Check in and
   Check out.
2. **Found you**: "Welcome back, Jane", the company she's visiting and her host, to confirm or
   change. Someone linked to several companies here picks one.
3. **New here**: first and last name, their company, email or phone (optional), then the company
   they're visiting (type a few letters) and the host (or "I'm not sure").
4. **Done**, then back to the start. Every screen goes back to the start after a set idle time.

The kiosk only ever shows a visitor's first name and the names of the company and host they
came to see: never an email, a phone number or a visit history. It answers only to a full
name (two words), tolerating case, accents, word order and one typo per name. Lookups are
rate-limited per kiosk, and a check-in can only be for someone a lookup just found.

## Equipment Checkout and other systems

Other systems read the directory through `/api/v1` with a key. **Settings > API clients**
adds one, with:

- the **sites** it sees (it gets only the companies there and their people who work there
  or at any site),
- whether it **can add people and companies** (Equipment Checkout's New person button),
- the **fields** it receives, as a checklist. Each client has its own column in the field
  access grid; a new one starts from the built-in Equipment Checkout column (name, company,
  job title, email, work phone).

The key is shown once and stored only as a hash; a new key stops the old one at once.
Nothing about visitors is ever shared.

| Request | What it does |
|---|---|
| `GET /api/v1/whoami` | The client's name, sites, write access and fields |
| `GET /api/v1/sync?since=<ms>` | Companies and people changed since then, the ids of everyone visible now, and a fields version that changes when its fields do |
| `GET /api/v1/companies`, `/people`, `/people/:id` | Lists, with `q`, `updated_since` and `companyId` |
| `POST /api/v1/people`, `/companies` | Adds one (write access); `match: true` returns the one already there instead |

Send the key as `Authorization: Bearer ivm_...`. Equipment Checkout's side is described in
its README (Settings > Directory).

## The database key

The key is 64 hex characters (32 random bytes). **Without it the data cannot be read**, and it
is not in backups. Keep a copy in your password manager from the start.

```bash
npm run new-key
```

The app reads the key from `DB_KEY_FILE` (in Docker, the secret `db_key` at
`/run/secrets/db_key`, used automatically), or from `DB_KEY`. It refuses to start without a
key, and refuses a key file inside the data directory.

To change the key, stop the app, make a new key and run:

```bash
DB_KEY_FILE=/path/old-key DATA_DIR=/path/data npm run rekey -- /path/new-key
```

Backups made before the change still need the old key.

On a Debian or Ubuntu host the key can instead be sealed to the machine's TPM, so it is
never on disk in readable form: see "Database key sealed to the TPM" under Docker.

## Running it locally

```bash
npm install
npm run new-key -- .db-key
DB_KEY_FILE=.db-key npm start
```

Then open http://localhost:3000 and create the first administrator. For demo data, run
`DB_KEY_FILE=.db-key node scripts/seed-demo.js` on an empty data directory before starting;
the sign-ins are written to `data/demo-login.txt`.

## Docker

```bash
mkdir -p secrets
npm run new-key -- secrets/db_key
sudo chown 1000:1000 secrets/db_key && sudo chmod 400 secrets/db_key
docker compose up -d --build
```

The container runs as uid 1000, so it must be able to read the secret file. Nginx Proxy
Manager on another host terminates HTTPS and connects to the container over HTTPS with
the self-signed certificate the app makes (`TLS_ENABLED=true`), as with Equipment Checkout.
Set `APP_URL` to the public address for Microsoft sign-in.

### Host hardening (Debian or Ubuntu)

The database is encrypted, but the server's memory is not: the SSN digits given with a
clearance validation request live there (never on disk) until they are wiped. The server
keeps them as bytes it can overwrite, never as JavaScript strings (which can't be wiped):
the request is read raw, the digits are copied out and blanked before the rest is parsed,
and the answer showing them to Security is written as bytes. Node's networking and TLS may
still hold copies briefly in buffers the app doesn't own. Keep that memory from being
written out or read:

- **No swap for the container.** docker-compose.yml sets `memswap_limit` equal to
  `mem_limit`. Check it took: `docker inspect identity-visitor-manager --format
  '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}'` shows the same number twice, and
  `docker info` shows no "No swap limit support" warning. Debian 11+ and Ubuntu 22.04+ use
  cgroup v2, where this works out of the box; on older hosts add
  `cgroup_enable=memory swapaccount=1` to `GRUB_CMDLINE_LINUX` in /etc/default/grub, run
  `sudo update-grub` and reboot.
- **Host swap encrypted, or none.** As a second line, either install the host with
  full-disk encryption (LUKS; the installer's "encrypt" option puts swap inside it), or turn
  swap off (`sudo swapoff -a` and remove the swap line from /etc/fstab; Ubuntu's is
  `/swap.img`), or give swap a random key at each boot in /etc/crypttab.
- **No crash dumps.** The compose file sets the container's core limit to 0. On the host,
  also stop crash handlers keeping dumps: on Ubuntu `sudo systemctl disable --now apport`;
  where systemd-coredump is installed set `Storage=none` and `ProcessSizeMax=0` in
  /etc/systemd/coredump.conf. Leave the `--heapsnapshot*` and `--report*` Node options unset.
- **Who can read process memory.** Anyone in the `docker` group, or with sudo, can
  `docker exec` into the container and read its memory: treat both as root and keep them to
  the people who run the server. The container drops every capability (no ptrace inside it);
  on Debian also set `kernel.yama.ptrace_scope = 2` in /etc/sysctl.d/ (Ubuntu defaults to 1).
- **Encrypted on the wire.** Keep `TLS_ENABLED=true` (the default), so the hop from Nginx
  Proxy Manager to the container is HTTPS too.

### Database key sealed to the TPM (optional)

Instead of a key file in `secrets/`, the key can be sealed to the host's TPM with
`systemd-creds`: on disk it is then encrypted by a key that never leaves the TPM chip, so a
stolen disk, a copied VM image or a backup of the host's files doesn't give it away. A
systemd service asks the TPM to unseal it as the app starts and hands it to the container
in memory; it is never written to disk in plain form. It doesn't protect against root on
the running machine, who can unseal it as the service does.

Needs systemd 250 or later (**Debian 12 or later, Ubuntu 24.04 or later**; Ubuntu 22.04 is
too old), a TPM 2.0 (on a VM, a virtual TPM: Proxmox, Hyper-V Gen 2 and VMware all offer
one), Docker Compose v2 and rootful Docker.

```bash
sudo bash deploy/tpm/setup.sh check              # what the host has, and what's missing
sudo bash deploy/tpm/setup.sh seal               # seals secrets/db_key; checks it unseals
sudo bash deploy/tpm/setup.sh install            # installs and starts identity-visitor-manager.service
shred -u secrets/db_key                          # once the app runs, drop the plain copy
```

What it does:

- `seal` encrypts the key with `systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs=7` into
  `/etc/identity-visitor-manager/db_key.cred`, and checks it unseals to the same key before
  replacing anything. `--pcrs 7` (the default) also ties it to the Secure Boot state, so
  booting another system or turning Secure Boot off gets nothing; `--pcrs none` ties it to
  the TPM chip alone. `seal -` reads the key from the keyboard instead of a file, and
  `--remove` deletes the key file once it is sealed.
- `install` stops containers started the plain way, installs the service from
  `deploy/tpm/identity-visitor-manager.service.in` and starts it. The service unseals the
  key (`LoadCredentialEncrypted`), copies it into `/run/identity-visitor-manager/db_key`
  (memory, owned by the container's uid 1000, mode 0400, removed when the service stops),
  and runs `docker compose` with `deploy/tpm/docker-compose.tpm.yml`, which points the
  `db_key` secret there and turns Docker's own restart off so systemd starts and restarts
  the container. Logs: `journalctl -u identity-visitor-manager -f`.
- After updating the app: `docker compose build && sudo systemctl restart identity-visitor-manager`.
  Use `systemctl`, not `docker compose up`, to start and stop it from now on.
- `status` shows the service and whether the key still unseals; `uninstall` removes the
  service and leaves the sealed key.

**Keep the key in your password manager.** A firmware update, especially the Secure Boot
revocation (dbx) updates Debian and Ubuntu ship, can change what PCR 7 measures, and then
the key no longer unseals and the app doesn't start. Seal it again from your copy and
restart:

```bash
sudo bash deploy/tpm/setup.sh seal -             # paste the key; it isn't shown
sudo systemctl restart identity-visitor-manager
```

A new machine or motherboard has a different TPM: the `.cred` file is useless there.
Restore the data, seal the key from your copy on the new host, and install the service.
To change the key, stop the service, unseal the current key into a file in `/run`
(`sudo systemd-creds decrypt --name=db_key /etc/identity-visitor-manager/db_key.cred /run/old-key`),
run the rekey above with it, seal the new key, delete both files and start the service.

**Backups:** Settings > Import, export and backup > Download backup gives a consistent copy of
the database, still encrypted. To restore, stop the container, put the file in the volume as
`identity.db` (removing any `identity.db-wal` and `identity.db-shm`), and start it with the key
that was in use when the backup was made.

## CSV columns

People: `first_name`, `last_name`, `company` (required); `preferred_name`, `job_title`,
`email`, `work_phone`, `mobile`, `site`, `can_host`, `notes`, `active`, and custom field keys
(shown under Settings > Fields). Someone in the same company with the same email (or, without
one, the same name) is updated.

Companies: `name` (required); `sites` (`Harbour Point: Suite 100; Riverside`), `phone`,
`email`, `website`, `address`, `notes`, `active`, and custom field keys. A company with the same
name is updated.

If any line has a problem, nothing is imported. Columns for fields the importer can't change
are skipped and listed.

## Tests

```bash
npm test
```

Ten suites: the encrypted database (nothing readable on disk, wrong key refused, rekey),
field access and site limits (the most important), visitors (name matching, end of day across
time zones and daylight-saving changes, retention, merging), Entra sign-in against a fake
Microsoft, the HTTP API end to end, the kiosk and visitor routes end to end, the API for other
systems, badges, clearances and visitor events (rules and routes), and clearance validation (who
sees the queue, and that the SSN digits never reach the database, the audit trail or the
log, and are wiped on time). Equipment Checkout's own tests run its directory mode against this app.

## Not yet tried

- The Docker image build (Docker isn't running on the development machine), including the
  compose file's memory, swap and core-dump limits
- Sealing the database key to a TPM (deploy/tpm/): the script's logic was run against a
  stand-in for systemd-creds, not on a real Debian or Ubuntu host with a TPM
- Microsoft Entra sign-in against a real tenant (only a fake Microsoft)
- Passkeys on a real device
- The kiosk on a real iPad (only a desktop browser at iPad sizes): the on-screen keyboard,
  Home Screen mode, Guided Access
- A large directory: lists are paged, but nothing has been measured beyond a few hundred people
