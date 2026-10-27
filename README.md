# Identity and Visitor Manager

[![Container image](https://img.shields.io/badge/ghcr.io-spicy384%2Ftenant--identity--visitor--manager-blue)](https://github.com/spicy384/tenant-identity-visitor-manager/pkgs/container/tenant-identity-visitor-manager)

A directory of the companies in one or more buildings and the people who work for them,
and of their visitors, kept in an encrypted database, with control over which fields each
role can see. Visitors check themselves in and out on an iPad kiosk in each lobby, badges and
clearances are tracked and validated, offices are drawn on floor plans and assigned to
companies, and Equipment Checkout takes its people from here.
The design and decisions are in [PLAN.md](PLAN.md).

## Finding your way

- **Sections.** The header has Home, Tenants (companies, people, their badges), Visitors (in
  the building, expected, visitors, the visit log, visitor badges), Facilities (floor plans,
  offices, rates, leases and charges: for roles given facilities access, and Finance), Finance
  (invoices, balances, payments, billing settings: for roles given finance access), Security (the clearance queue,
  re-checks and expiry, all badges: for Security and administrators) and Settings
  (administrators). The pages of the chosen section are in the bar under the header; a
  section or page the account can't open isn't shown.
- **Home** is each person's dashboard. **Customize** adds, removes and reorders modules: who
  is in the building, who is expected today, visitors whose check-in the desk must finish, visitors to
  check, badges out past their time, a quick list of tenants, offices by status with the space
  let and the monthly rent (for those who see facilities), leases ending soon, overdue invoices
  (for those who see the books), and for Security the clearance
  queue, visitor re-checks, clearances expiring and recent validations (administrators get
  all but the queue). Only modules the role can see are offered, every role starts with a
  layout that suits it, and the choice is kept with the account, on any device. The cards
  stand in columns (as many as fit), so a long one only moves the cards below it in its column.
- **Sites.** The site button in the header (and the buttons on Home) switch site at once:
  every page, count and module follows it, or "All sites". The choice is kept with the
  account too, so it follows you to another desk.
- **Settings** has a grouped menu down the side: Building, Directory, Security, Accounts and
  Records. **General** sets the app's name, shown at the top left, on the sign-in page and in
  the browser's tab, and the line under it (shown when no single site is chosen; otherwise the
  line shows the chosen site).
- **Light or dark.** The moon/sun button in the header switches at once; Account > Appearance
  also offers "Match this device" (the default). The choice is kept with the account, so it
  follows you, and applied before the page draws.
- **Motion.** Buttons and rows respond the moment they are pressed; dialogs, menus and messages
  leave the way they came; the header is a translucent layer the page scrolls under. On a
  phone, dialogs are sheets from the bottom: drag the top down (or flick it) to put one away.
  The check-in steps and the kiosk screens slide the way the visit is going, and a dragged floor
  plan glides on when let go. The device's "reduce motion" (fades only), "reduce transparency"
  (solid surfaces) and "increase contrast" settings are followed.

## The directory

- **Sites.** One or more buildings, each with its own name and logo (for its kiosk), time
  zone and end-of-day check-out time. With a single site, nothing asks which.
- **Companies** with contact details, placed at one or more sites with a suite or floor at each.
- **People** in a company: names, job title, email, phones, the site they work at, whether they
  can host visitors.
- **Inactive** companies and people stay on record but are left out of the lists: Companies,
  People and a company's own people each have **Show inactive** to bring them back (on a
  company's page it says how many, and the choice is kept in that browser).
- **Several at once.** On Companies, **Select** turns the list into tick boxes: **Merge** the
  chosen companies into one (choose which to keep, then edit its name and details, with each
  other company's different value offered under its field; its sites become everywhere any of
  them was), make them inactive or active, or delete them (administrators). A merge moves their
  people, visitors' links, visits and visitor events, and fields added to one company alone,
  then deletes the others. On People, tick boxes beside each row (and one for the whole page)
  choose people across pages: **Edit** sets the ticked fields, custom ones included, the same
  for all of them (a ticked field left empty is cleared), or make them inactive or active, or
  delete them (administrators). Each is all or nothing, and audited.
- **Custom fields** for companies and people: text, long text, number, date, yes/no, choice
  list, email, phone, web address. A field is either on every record (and can be required) or
  added to one record only, and can later be made a field for every record. Administrators
  manage them, and so does any role with **Manages custom fields** (Settings > Roles; Manager and
  Security to start with): it adds fields and changes their names, choices and whether they're
  required, for the records that role can change, and badge fields if it issues or manages
  badges (Security: badge fields only). Filling in a badge's fields stays with the roles that
  manage badges. Deleting a field (and
  every value in it) and the field access grid stay with administrators; such a role sees
  Settings with the Fields page only.
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
  `FrontDesk`, ...); every one that matches is given. Once Microsoft sign-in is set up and
  ready, the sign-in page shows its button alone, with local accounts and passkeys folded away
  behind **Sign in with a local account**; a browser that last signed in with a local account
  opens with that form showing. Without Microsoft sign-in, the local form is all there is.
- **Several roles on one account.** Under Settings > Users, tick any number of roles for an
  account. It can do whatever any of them can: the highest level of each area (directory,
  visitors, badges, facilities), and every field that any of its roles sees in the field access
  grid, each role's own limits applied first (a role that doesn't see clearance levels still
  adds nothing about clearances). With Security among its roles it validates clearances.
  Administrator covers everything, so it is never combined. Site limits stay with the account.
  Removing a role takes it from the accounts that have others too, and is refused while it is
  someone's only role.
- **Entra with a certificate instead of a client secret.** Under Settings > Microsoft Entra ID,
  choose how the app proves who it is to Microsoft:
  - **Make a certificate** creates a key and a self-signed certificate (1, 2 or 3 years). The
    private key stays in the encrypted database and never leaves the server. Upload the
    downloaded `.cer` file to the app registration (Certificates & secrets > Certificates).
  - **Upload a certificate** takes your own, as a PFX/P12 file with its password (modern AES
    ones and older 3DES/RC2 ones, from Windows or OpenSSL) or as PEM files (the key may be
    encrypted). It must be RSA, 2048 bits or more. The password isn't kept.
  - Each sign-in request is signed with the key (a PS256 client assertion), so no secret is sent.
  - **Test with Microsoft** asks Entra for a token with the saved settings, or with one
    certificate, and shows whether it is accepted (and Microsoft's reason if not).
  - Settings shows each certificate's thumbprint (as the Entra admin center shows it) and
    expiry date, and warns 30 days before the one in use expires; the server log warns too.
  - To renew without a gap: make a new certificate, add it in Entra, test it, choose **Use this
    one**, then remove the old one here and in Entra. Up to 5 can be kept.
- **CSV import and export**, an **encrypted backup download** and an **audit log** that
  records which fields changed, never their values.

## Visitors

- **Visitors** are kept apart from tenant people. Each can be linked to any number of
  companies, with a usual host at each. They have their own fields in the field access grid,
  custom fields included, governed by each role's visitor access. Besides name and company,
  a visitor has a **type** (Guest, or Service Technician: someone who comes to do work or
  maintenance, not tied to a tenant) and a **citizenship** (U.S. citizen, or which country,
  picked from a list).
- **In the building** lists everyone checked in (per site, with the header's site picker),
  with check-out buttons, a desk check-in, and a print-friendly evacuation list.
- **Visitors** lists everyone, with those who registered themselves at a kiosk marked "To
  check": staff confirm them, correct them, or merge them into an existing visitor. A visitor
  can be blocked: the kiosk then sends them to reception, and the desk needs a manager's say-so.
- **Notes.** A visitor's dialog shows their notes (or None), with **Add notes** or **Edit
  notes** for those who may change visitors and the notes field (field access grid).
- **Checking in at the desk** (Check in a visitor, on Home and In the building; Check in
  beside an expected guest) walks through one step per page:
  1. **Find** them in the visitor list, or add them: name, company, type, citizenship, the
     point of contact they're visiting, picked by typing their name (their tenant comes with
     them, and the site too when it can only be one). A service technician's point of
     contact can be anyone in the directory. Changing the site keeps the point of contact
     when their company is there.
  2. **Confirm** their details, the point of contact's (job title, phones, email, as the
     role's field access shows them) and the purpose of the visit.
  3. **ID**: which ID they showed (driver's license, passport, CAC, state ID or another
     government ID) and that its name and photo match them. Only the type, who checked it and
     when are kept: never the ID's number.
  4. **Badge**: a badge kept for them (picked for the event they're expected at, or reserved
     for a regular visitor) is shown large, with **Badge handed over** and **Can't find it?
     Issue a different badge**. Otherwise the desk enters the number of the badge they hand
     over: it must be an active visitor badge, valid at the site, that the visitor may hold.
     A visitor whose clearance doesn't count (not validated by Security, due a re-check, or
     expired) is shown the uncleared visitor badge image, with a note saying so, and can be
     sent to Security from here (**Request clearance validation**). **No badge needed**
     (audited) finishes without one.

  Until the badge is given, **Back** (or the Confirm and ID steps at the top) goes back to
  change the point of contact or purpose, or to check the ID again; the audit log notes an ID
  checked again and what it was before. Once the badge is given the check-in stands.
- **Complete check-in**: a visitor who checks themselves in at a kiosk is told to show their ID
  at the desk. A bright banner at the top of every page, and the Complete check-in module on
  Home, show them to staff who give badges out at that site (and the site chosen in the
  header): who, which kiosk, when, whom they are visiting and why. **Check ID** opens the
  check-in at the ID step (at Confirm first if something is missing, such as the point of
  contact), and **Give badge** at the badge step once their ID is checked. It clears once
  they have a badge, need none, or check out. Pages check every 15 seconds.
- **Reserved badges**: a regular visitor can have a visitor badge kept for them (their
  visitor page, Reserved badge). Check-in tells the desk to hand them that badge; it goes
  back into stock when they leave and stays theirs. Nobody else can be given it.
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
- **Facility codes.** A badge can also have a facility code (2 or 3 digits), kept apart from
  its number as CCURE 9000 keeps it. It is optional, Security sets it (one at a time, for a
  range, by changing several badges at once, or from an import's facility code column), and
  everyone who sees badges sees it, in a column of its own. The same number can be under
  several facility codes; a number is unique within its code (no code counts as a code of its
  own). Elsewhere a badge is written with its code: 101-12345. Where someone types a badge's
  number (giving a visitor their badge at check-in, reserving one), the code can be left out
  while the number is unique, given in its own box, or written in (101-12345); when the number
  is under several codes, the app names them and asks for the code.
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
- **Validating several at once.** For people already checked outside the app, Security ticks
  them on **People** or **Visitors** (one box for the whole page; picks carry across pages and
  searches) and chooses **Validate clearance**: one level (or no clearance), and optional
  granted and expiry dates, the same for each, up to 1,000 at a time. It is all or nothing:
  if one of them can't be validated, none are. Waiting requests for them close and their digits
  are wiped; the audit trail gets an entry for each person, as when validated one at a time.
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
- **Several badges at once** (Security): tick boxes on the Badges page, then **Change** to move
  them to another type (visitor, tenant or personnel), classification or level, the sites they
  are valid at, temporary, status or notes, or **Retire** or **Delete** them. A badge that is out
  can't change type, classification, level or temporary until it is taken back, and one that
  has been given out can only be retired; if any chosen badge can't take the change, none does.
- **Access.** Each role has a badge level as well as directory and visitor levels: read to
  look; issue and return to give badges out and take them back (Front desk and Manager to
  start with); or issue, return and manage, which also adds, changes, retires and removes
  badges (Security and Administrator). Only those who manage badges keep the stock.
- **Who sees clearance levels.** Each role has a **Sees clearance levels** switch under
  Settings > Roles: on for Administrator, Manager and Security to start with (Security
  always), off for Front desk, Viewer, new roles, kiosks and API clients. Roles without it
  never receive a level's name or id from the server: not on people or visitors (their
  clearance details stay hidden whatever the field access grid says), not on badges, not in
  the level list, not in the reason a badge is refused. They still see the validation tag.
- **Badge images.** Under Settings > Badges and clearances an administrator uploads what
  each level's badges look like: a tenant image (personnel badges use it too) and a visitor
  image per level, and a pair for uncleared badges. Roles that don't see clearance levels
  see these instead: beside each badge in the list and wherever one is offered, and large,
  as "Give them this badge", when they give someone a badge or check a visitor in. That large
  image is of the highest badge on offer that the person may hold, which is listed first. They
  add a cleared badge by picking its image rather than a level name. Images are PNG or JPEG up
  to 1 MB (other formats are converted in the browser), served under a random address that
  changes with each upload and says nothing about the level.
- **Custom badge fields.** Settings > Fields has Badge fields alongside the others (a lanyard
  color, a locker number, a cost center). They show on the badge's dialog, in the add, range
  and edit forms, in Change for several badges and in the badge import. Like the badges
  themselves, only roles that manage badges (Security and Administrator to start with) change
  them; roles that issue or read badges can be given read-only or hidden under Field access.

## Facilities

For roles given **facilities** access under Settings > Roles: Administrator and Manager to
start with (read and change), and any custom role, with read only or read and change. Nobody
else sees the Facilities section, the offices on a company's page, or the Offices module on
Home.

- **Floor plans.** Each site has floors; each floor has a plan, a PNG or JPEG (other image
  formats are converted in the browser; export a PDF plan as an image first). **Draw offices**
  turns on drawing, with three tools. **Rectangle**: drag on the plan. **Outline**, for offices of
  any shape: click each corner in turn, then click the first point (or double-click, or press
  Enter) to finish; Backspace takes back a point, Escape starts again. With either tool, click an
  office to reshape it: drag it to move it, drag a point to move that point, drag a + halfway
  along a side to add a point, right-click a point (or click it and press Delete) to remove it;
  double-click an office to open it. An office's outline is kept as shares of the plan, so it
  stays put at any size and when the plan is replaced. Offices can also be added without
  drawing and placed later.
- **Zoom and pan.** The − and + buttons on the plan zoom in and out (up to 800%), and the
  percentage between them fits the whole plan again; Ctrl or Cmd with the mouse wheel, or a
  trackpad pinch, zooms where the pointer is. Drag the plan to move around it; while drawing,
  hold Space and drag, or drag with the middle mouse button. Each floor keeps its zoom while you
  work on it.
- **Scale (optional).** **Set scale**: click the two ends of something whose real length you
  know (a wall, a dimension line) and give its length in feet. Each office's area is then
  measured from its outline and offered as a suggestion: it fills in the size of a new office
  (change it if you know the real size), shows beside the size you entered, and **Fill in
  missing sizes** uses it for offices that have none. The size you enter is always the one used
  for costs; a measurement never overwrites it. Replacing the plan keeps the scale when the new
  plan has the same shape, and clears it otherwise.
- **Room types and classification.** Each room has a type (Office, Conference Room, Meeting
  Room, Storage, IT Room to start with) and is **Unclassified** or **Classified** with a
  subcategory (SCAR or SCIF to start with). Facilities > Room types renames them, adds more,
  sets each one's color, and removes those no room uses; each type also says whether its rooms
  are assigned to companies (Office and Storage) or **shared** (the others: no company, no
  rent). Everyone who sees Facilities sees a room's type and classification.
- **Colors.** **Color by** above the plan colors the rooms by **Availability** (as below), by
  **Room type** or by **Classification**, in the colors set for them; the key beside the plan
  follows, with how many rooms on the floor have each. The choice is kept in this browser.
- **Status.** Each room's status today: **available**, **occupied**, **upcoming** (free now,
  assigned to a company from a later date), **shared** (a type that isn't assigned to companies)
  or **unavailable** (marked so, e.g. under renovation, and can't be assigned). The key beside
  the plan counts them, with the floor's space, the space let and free, and the rent.
- **Assigning.** Click an office to see it and **Assign to a company** from a date, to an end
  date (its last day) or with no end. An office has one company at a time, so dates can't
  overlap. **End** sets the last day, and ended assignments stay as the office's history.
  **Remove** is for one made by mistake. Dates are days at the site.
- **Size and cost.** Each office has its size in square feet. Rates are dollars per square
  foot a month: a **company's** own rate wins, else the **office's**, else the **site's**
  default (Facilities > Rates, and Change rate on a company's page). An office's monthly cost
  is its size times that rate; a free office shows what it would cost. A room can instead be
  priced at a **fixed amount a month** (Priced on its form), which then wins over every rate.
- **Rooms** lists every room at the chosen site with its floor, type, classification, size,
  status, company, rate and monthly cost, totals underneath; filter by type or status, or search.
- **Several rooms at once.** Tick rooms on the Rooms page, or choose **Select rooms** on a
  floor plan and click them (or Choose all on this floor), then **Change** to set the room type,
  classification, rate, unavailable or notes the same on all of them, or **Delete** them. If any
  room can't take the change (an assigned room can't become a shared type or unavailable, or
  be deleted), none does, and the message names it.
- **On a company's page:** its offices now, upcoming and before, the rate it pays, and its
  space and rent now. **Assign offices** gives it offices from there: choose the dates, then
  click free offices on a floor's plan (taken ones are greyed out) or tick them in the list,
  across any floors, with their total size and monthly cost shown as you go; all of them are
  assigned, or none if one can't be. A company that has an office now or later can't be deleted until those
  assignments end; merging companies moves their offices and history to the one kept.

## Leases, charges and invoices

- **Who does what.** Managers keep leases and charges, and read invoices, payments and
  balances. The built-in **Finance** role sees every financial detail (leases, rates, charges)
  and keeps the books: it logs charges, makes and issues invoices, records payments, and keeps
  the billing settings and the QuickBooks connection. Administrators can do it all. Settings >
  Roles gives any role finance access (none, read, or read and change).
- **Leases** (Facilities > Leases): a company's agreement for offices, from a start date to an
  end date (none: month to month), with a reference, a deposit and notes. Rent comes from the
  rates (each office's size times the rate that applies, or the office's own fixed monthly
  rent) or is a fixed amount a month; either can go up by a percentage on each anniversary. Making a lease assigns its offices to the
  company for its dates, and changing its dates or offices changes those assignments, so an
  office still has one company at a time. Offices assigned from Rooms or a company's page get
  a lease of their own (the ones assigned together share one); the assignments made before
  leases became leases the same way. Moving one office of several to other dates on Rooms gives
  it a lease of its own (not for a fixed rent: change that on the lease). A lease that has been
  invoiced can't be deleted, only ended; Home shows the leases ending within 90 days.
- **Charges** (Facilities > Charges): billable items and hours logged against a company: from
  the **price list** (say After-hours HVAC at $75 an hour, its rate filled in) or one-off. A
  charge can be changed or deleted until it is on an invoice.
- **Invoices** (Finance > Invoices): **Invoice a month** drafts an invoice for each company
  with its leases' rent for that month (a part month for the days the lease covers) and its
  charges not invoiced yet up to the month's end. A month's rent is invoiced once; running it
  again adds only what is new. A draft can take more lines (anything else, or a credit as a
  negative amount; a charge; another month's rent) and lose lines; **Issue** gives it the next
  number (Billing settings sets the prefix and where numbers start), and its lines are then
  fixed. **Void** keeps an issued invoice's number on record and frees its charges and rent to
  be invoiced again (not once it has payments). **Print** opens the invoice as a page to print
  or save as PDF, with who to pay and the footer from Billing settings. No tax.
- **Payments** are recorded against issued invoices (date, amount, method, reference), in
  part or in full but never more than is owed: an invoice is open, partly paid, paid, or
  overdue past its due date (the payment terms in Billing settings). **Balances** shows what
  each company owes, by how late: not due yet, 1-30, 31-60, 61-90 and over 90 days.
- **QuickBooks.** **Export** downloads issued invoices or payments for a date range: CSV in
  QuickBooks Online's import layout, or IIF for QuickBooks Desktop (with the customers and items
  they use). Billing settings names the QuickBooks accounts and items. Or connect **QuickBooks
  Online** directly (Billing settings): register an app at developer.intuit.com (Accounting
  scope), add the redirect URI shown to it, enter its client ID and secret, and Connect. Then
  **Sync now** sends issued invoices (making their customers and items when missing) and
  payments recorded here, and brings back payments made in QuickBooks against those invoices.
  The secret and tokens stay in the encrypted database. Intuit wants https:// for a real
  company, so set `APP_URL`.
- Merging companies moves their leases, charges and invoices too; an issued invoice keeps the
  name it was billed to.

## Expected visitors

**Expected** lists a day's visitor events: a name, time, site, company and host, and the guests
expected. Each guest shows as expected, arrived but not yet through the desk, here (since
when) or left. Staff who give badges out can pick the visitor badge to hand each guest
(Badge column): check-in then shows that badge. Guests are picked from
visitors on record or added as new ones (the app says when someone of that name is already
on record), and are linked to the event's company and host, so the kiosk recognizes them.
At the kiosk an expected guest is offered their event's company and host first; checking
in, at the kiosk or the desk, marks them arrived. The navigation counts guests expected
today who haven't arrived.

An event's **point of contact** is picked by typing their name: the person comes with their
company (type a company's name instead for no one in particular), across every site the
account sees, and the site list follows that company's sites.

An event can **repeat**: every day, every weekday, weekly on chosen days (every week or every
other week), or monthly (on the same date, or the same weekday such as the second Tuesday;
a month without the date is skipped), until a date at most a year after the first. Each date
is an event of its own. Guests added when it's made are expected on every date; later, a
guest can be added to or taken off one date, or that date and the later ones. Editing or
canceling works the same way (later dates keep their own dates).

Each event has **notes**, shown under its name. **Add notes** or **Edit notes** changes them
without opening the whole event form; for a repeating event, on that date or on it and the
later dates.

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
3. **New here**: first and last name, their company, email or phone (optional), whether they're
   visiting someone or here to do work or maintenance, then the company they're visiting
   (type a few letters) and the host (or "I'm not sure").
4. **About your visit**: what brings them in, and for someone new (or a visitor on record
   without them) whether they're a U.S. citizen, and if not, their country, typed and picked
   from a list, and their company.
5. **Done**: they're asked to show their photo ID at the front desk, who will give them their
   visitor badge. Then back to the start. Every screen goes back to the start after a set idle
   time.

The kiosk only ever shows a visitor's first name and the names of the company and host they
came to see: never an email, a phone number, a citizenship or a visit history. It asks a
visitor on record only for what their record lacks, and never changes what it has. It answers only to a full
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

The app reads the key from `DB_KEY_FILE` or `DB_KEY` (or, with neither, the Docker secret
`/run/secrets/db_key`). With `DB_KEY_CREATE=true`, as the compose file sets, a fresh install
makes its own key in `DB_KEY_FILE`; it never makes one for a database that already exists. It
refuses to start without a key, and refuses a key file inside the data directory.

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

Every push to `main` publishes `ghcr.io/spicy384/tenant-identity-visitor-manager:latest`
for amd64 and arm64 (GitHub Actions, `.github/workflows/docker-image.yml`). A server needs
only Docker and the compose file:

```bash
mkdir -p ~/identity-visitor-manager && cd ~/identity-visitor-manager
curl -fsSLO https://raw.githubusercontent.com/spicy384/tenant-identity-visitor-manager/main/docker-compose.yml
docker compose up -d
```

Then open https://<host>:3000 (the certificate is self-signed until a proxy is in front)
and create the first administrator.

**The database key.** The first start makes one in the `identity-keys` volume, separate from
the data in `identity-data`. Copy it into your password manager straight away; without it
the data can't be read, and it isn't in backups:

```bash
docker compose exec identity cat /keys/db_key
```

To seal it to the TPM instead (below), clone the repository rather than fetching the compose
file alone: the service needs `deploy/tpm/`.

**Updating:** `docker compose pull && docker compose up -d`. The data volume carries over.
**Versions:** a tag such as `v1.2.0` also publishes `:1.2.0` and `:1.2`, and every build
is reachable as `:sha-<commit>`; change the tag in the compose file to pin one. Bump
`version` in `package.json` in the same commit as the tag.
**From source:** in a clone, `docker compose up -d --build` builds the image locally under the
same name.

Nginx Proxy Manager on another host terminates HTTPS and connects to the container over
HTTPS with the self-signed certificate the app makes (`TLS_ENABLED=true`), as with Equipment
Checkout. Set `APP_URL` to the public address for Microsoft sign-in.

### Settings in the environment

The compose file sets what most installs need. Anything else goes in a `.env` file next to
it (one `NAME=value` per line), which reaches the container as it is; values there also
override the compose file's defaults.

| Setting | Default | What it does |
| --- | --- | --- |
| `APP_URL` | from each request | The public address (https://directory.example.com); needed for Microsoft sign-in |
| `KIOSK_PORT` | `3001` | The kiosks' own port; empty serves the kiosk at /kiosk/ on port 3000 |
| `KIOSK_URL` | from the request | The kiosks' public address, shown on Settings > Kiosks |
| `TLS_ENABLED` | `true` | HTTPS with a self-signed certificate the app makes in /data/tls |
| `TLS_HOSTS` | | Extra names or IPs for that certificate, comma separated |
| `TLS_CERT`, `TLS_KEY` | | Your own certificate and key files instead (mount them read-only) |
| `COOKIE_SECURE` | `true` | Marks the session cookie Secure; false only for plain http:// |
| `TRUST_PROXY` | private networks | Which proxies may set X-Forwarded-For: `false`, a hop count, or addresses |
| `TZ` | `UTC` | The server's time zone (each site has its own for visits) |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | | Microsoft Entra sign-in; or set it up in the app under Settings |
| `ENTRA_DEFAULT_ROLE` | `none` | The role a new Entra user gets |
| `ENTRA_CERT_FILE`, `ENTRA_KEY_FILE`, `ENTRA_KEY_PASSPHRASE` | | Sign in to Entra with a certificate (PEM files) instead of `ENTRA_CLIENT_SECRET`; they win over a secret |
| `ENTRA_PFX_FILE`, `ENTRA_PFX_PASSWORD` (or `ENTRA_PFX_PASSWORD_FILE`) | | The same from one PFX/P12 file |
| `CLEARANCE_DIGITS_HOURS` | `36` | Hours SSN digits given for clearance validation stay in memory (at most 168) |
| `LOGIN_RATE_LIMIT` | `20` | Failed sign-ins allowed before a pause; `0` turns the limit off |
| `PASSKEY_RP_ID`, `PASSKEY_ORIGIN` | from the request | The passkey domain and origin, if the proxy hides them |
| `DB_KEY_FILE`, `DB_KEY_CREATE` | `/keys/db_key`, `true` | Where the database key is, and whether a fresh install makes one |

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

Instead of a key file in the `identity-keys` volume, the key can be sealed to the host's TPM with
`systemd-creds`: on disk it is then encrypted by a key that never leaves the TPM chip, so a
stolen disk, a copied VM image or a backup of the host's files doesn't give it away. A
systemd service asks the TPM to unseal it as the app starts and hands it to the container
in memory; it is never written to disk in plain form. It doesn't protect against root on
the running machine, who can unseal it as the service does.

Needs systemd 250 or later (**Debian 12 or later, Ubuntu 24.04 or later**; Ubuntu 22.04 is
too old), a TPM 2.0 (on a VM, a virtual TPM: Proxmox, Hyper-V Gen 2 and VMware all offer
one), Docker Compose v2 and rootful Docker.

```bash
sudo bash deploy/tpm/setup.sh check                  # what the host has, and what's missing
sudo bash deploy/tpm/setup.sh seal                   # seals the key the app made; checks it unseals
sudo bash deploy/tpm/setup.sh install                # installs and starts identity-visitor-manager.service
docker volume rm identity-visitor-manager_identity-keys   # once the app runs, drop the plain copy
```

What it does:

- `seal` encrypts the key with `systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs=7` into
  `/etc/identity-visitor-manager/db_key.cred`, and checks it unseals to the same key before
  replacing anything. `--pcrs 7` (the default) also ties it to the Secure Boot state, so
  booting another system or turning Secure Boot off gets nothing; `--pcrs none` ties it to
  the TPM chip alone. By default it reads the key the app made, straight out of the
  `identity-keys` volume; `seal FILE` takes a key file instead (`--remove` deletes it once
  sealed), and `seal -` reads it from the keyboard.
- `install` stops containers started the plain way, installs the service from
  `deploy/tpm/identity-visitor-manager.service.in` and starts it. The service unseals the
  key (`LoadCredentialEncrypted`), copies it into `/run/identity-visitor-manager/db_key`
  (memory, owned by the container's uid 1000, mode 0400, removed when the service stops),
  and runs `docker compose` with `deploy/tpm/docker-compose.tpm.yml`, which points the
  `db_key` secret there, stops the app making a key of its own, puts an empty in-memory
  /keys in place of the `identity-keys` volume (so the volume can go), and turns Docker's
  own restart off so systemd starts and restarts the container. Logs: `journalctl -u identity-visitor-manager -f`.
- After updating the app: `docker compose pull && sudo systemctl restart identity-visitor-manager`
  (or `docker compose build` in place of the pull, to build from the clone).
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

## Importing (Access or CSV)

**Import** on the People, Visitors and Badges pages (and Settings > Import, export and backup)
takes an Access database (.accdb or .mdb, up to 100 MB) or a CSV file, of people, companies,
visitors or badges. Each account is offered only what it may change: people and companies
need directory change access, visitors visitor change access, and badges the badge manage
level (Security).

1. Choose the file, and what it holds. A password-protected Access
   database needs its password (some newer Access encryption can't be read: export that table
   to CSV from Access instead).
2. Pick the table (the best fit is chosen for you), then match each field to one of its
   columns, or give one value for every row (handy for the company or site). Matches are
   suggested from the column names: `Surname` for Last name, `Firm` for Company, and so on.
   A preview shows the first rows as they'll be imported, and which columns are left out.
3. Import. The same rules as before apply: only fields the account can change, and someone
   already on record is updated rather than added twice. Rows with nothing in them are passed
   over. By default, if any row has a problem (a required field left empty, a company that
   doesn't exist, ...) nothing is imported and the problems are listed by row; from there,
   **Import the rest, skipping these rows** imports the others. Or tick **Skip rows with
   problems** before importing. Either way you get the skipped rows with the reason for each,
   and can download them as a CSV with a problem column, to fix and import again. Each row is
   saved on its own, so one that fails part-way (say after adding its new company) leaves
   nothing behind.

The file is read on the server and held in its memory only, for 15 minutes or until the
import is done or canceled, by the account that sent it; it is never written to disk. Yes/no
columns become yes or no, and dates become YYYY-MM-DD. At most 20,000 rows at a time.

A company's site can come from one column (a site's name) and its suite from another.

- **Visitors**: first and last name (required), their organization, email, phone, notes,
  blocked (yes/no), the company they visit and their host there (by name), and custom fields.
  A visitor with the same email, else exactly the same name, is updated. Imported visitors
  count as checked by staff. Clearances aren't imported: only Security sets them, by validating.
- **Badges**: number, type (personnel or staff, tenant, visitor) and classification (by name)
  required; clearance level (by name, only for roles that see clearance levels), the sites it
  is valid at (names separated by ;, empty for every site), temporary (yes/no), status
  (active, lost, retired), notes and custom badge fields. A badge with the same number is updated. The CSV
column names below are what a CSV file is matched to automatically, and what the CSV import
API takes.

### CSV columns

People: `first_name`, `last_name`, `company` (required); `preferred_name`, `job_title`,
`email`, `work_phone`, `mobile`, `site`, `can_host`, `notes`, `active`, and custom field keys
(shown under Settings > Fields). Someone in the same company with the same email (or, without
one, the same name) is updated.

Companies: `name` (required); `sites` (`Harbor Point: Suite 100; Riverside`), `phone`,
`email`, `website`, `address`, `notes`, `active`, and custom field keys. A company with the same
name is updated.

Companies may also give `site` and `suite` instead of `sites`. If any line has a problem, nothing
is imported. Columns for fields the importer can't change are skipped and listed.

## Tests

```bash
npm test
```

Fifteen suites: the encrypted database (nothing readable on disk, wrong key refused, rekey),
field access and site limits (the most important), visitors (name matching, end of day across
time zones and daylight-saving changes, retention, merging), Entra sign-in against a fake
Microsoft, the HTTP API end to end, the kiosk and visitor routes end to end, the API for other
systems, badges, clearances and visitor events (rules and routes), and clearance validation (who
sees the queue, and that the SSN digits never reach the database, the audit trail or the
log, and are wiped on time), and badge images (that roles without clearance levels never
receive a level name, pick levels by image, and are shown the right badge), importing from Access and CSV (against a small Access
database in test/fixtures, made by make-access-fixture.ps1), merging and bulk changes (custom badge fields too), and facilities
(floors and plans, offices, overlapping dates refused, which rate wins, who may see and change them), and accounts with several roles. Equipment Checkout's own tests run its directory mode against this app.

## Not yet tried

- Running the published image on a real host (Docker isn't running on the development
  machine), including the compose file's memory, swap and core-dump limits
- Sealing the database key to a TPM (deploy/tpm/): the script's logic was run against a
  stand-in for systemd-creds, not on a real Debian or Ubuntu host with a TPM
- Microsoft Entra sign-in against a real tenant (only a fake Microsoft), including signing in
  with a certificate and the Test button
- Passkeys on a real device
- The kiosk on a real iPad (only a desktop browser at iPad sizes): the on-screen keyboard,
  Home Screen mode, Guided Access
- Drawing offices on a touch screen (an iPad): drawing uses pointer events, tried only with a
  mouse (touch has larger points to grab, but right-click to remove a point needs the Delete key
  or a mouse there)
- A large directory: lists are paged, but nothing has been measured beyond a few hundred people
- The phone sheets' drag on a real phone (tried with pointer events in a desktop browser at
  phone size)
- QuickBooks Online against a real company (only a fake QuickBooks), and the CSV and IIF
  exports imported into real QuickBooks Online and Desktop
