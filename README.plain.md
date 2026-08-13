# Klassrun API — in plain English

*A non-technical companion to the developer README. If you have never written a line of code, start here. This explains what the Klassrun "engine" is, what it does, and how a school, its money, and its data move through it. Nothing here requires you to read code.*

*Current as of August 2026. Where the older developer README disagrees (it predates payments and the operations features going live), trust this one for the plain picture.*

---

## The one-paragraph version

Klassrun is software that lets a Nigerian private school run its academics online — lesson notes, schemes of work, exam questions, results, report cards, attendance, fees, and a parent portal, with AI doing the heavy writing. The whole product is built in **three separate pieces** that talk to each other. This document is about the third piece, the **API** — the engine room. No parent, teacher, or principal ever sees it directly, but every screen they touch is powered by it.

---

## The three pieces, and where this one sits

| Piece | Everyday name | What a person actually sees |
|---|---|---|
| `klassrun-web` | The marketing site (klassrun.com) | The public website that explains Klassrun and invites schools to sign up. |
| `klassrun-app` | The school portal (app.klassrun.com) | The screens people log into and click around — the "front desk." |
| **`klassrun-api`** *(this one)* | The engine (behind the scenes) | Nothing. It has no screens. It does the work and keeps the records. |

**An analogy.** If Klassrun were a bank: the **web** is the billboard on the road, the **app** is the branch you walk into and the teller you speak to, and the **api** is the vault and the ledgers in the back that no customer ever sees or touches. You always talk to the teller; the teller talks to the vault.

---

## What the engine actually does

**1. It remembers everyone and everything.** Every school, teacher, student, lesson note, result, fee, and payment lives in one central database. The engine is the only thing allowed to read from or write to it.

**2. It keeps schools completely separate.** Klassrun serves many schools from one system. Think of one large office building where every school has its own locked office and its own key. A teacher at School A physically cannot see School B's data — not by policy, but by the way the building is wired. Every single request carries the school's "key," and the engine refuses to open any other school's office.

**3. It writes with AI.** When a teacher asks for a lesson note, scheme of work, exam questions, or report-card comments, the engine sends a carefully-worded request to an AI (Anthropic's Claude) that has been fenced in to only do school work — no general chatbot, no off-topic answers. It then saves the result **before** telling the teacher it's ready, so work is never lost.

**4. It handles the money.** When a school subscribes, the engine talks to Paystack (the payment company), confirms the payment is real, and gives the school 30 days of access. More on this below — it's the most carefully-built part of the system.

**5. It enforces the rules.** Who is allowed to do what, and whether a school has paid, is decided here — never in the browser, where it could be tampered with.

---

## How one request travels (an example)

A teacher clicks **"Generate lesson note."** Here is the whole journey:

1. The click goes to the **app** (the front desk), never straight to the engine.
2. The app attaches the teacher's secure login token and forwards the request to the **engine**.
3. The engine asks, in order: *Who are you?* (valid login), *Are you allowed to do this?* (a teacher, not a parent), *Has your school paid / is it still in trial?* (billing).
4. Only if all three pass does it do the work: fetch the class and subject, ask the AI, and **save the note first**.
5. Then it replies to the app, which shows the teacher the finished note.

"Save first, reply second" is deliberate: even if something hiccups on the way back, the teacher's note is already safely stored.

---

## The money, step by step

This is the part built with the most care, because a payment must never be lost or double-counted.

1. **A school clicks Subscribe.** The engine asks Paystack to start a payment and sends the school to Paystack's secure checkout.
2. **The school pays.** Card, bank transfer, or USSD.
3. **Paystack tells the engine directly** (this message is called a *webhook*). The engine treats this — not anything the browser says — as the source of truth, because a browser can be closed, refreshed, or faked.
4. **The engine double-checks with Paystack** by asking Paystack to confirm that exact payment, and verifies it was in Naira and for at least the plan's price. A wrong currency or an underpayment is rejected outright.
5. **The engine grants 30 days.** If the school still had paid days left, the new 30 days stack on top (paying early = prepaying) — a payment can never shorten what a school already has.
6. **A receipt is emailed**, and the payment is written into a permanent ledger.

Two safety properties worth knowing in plain terms:
- **Paying once can never count twice.** Each payment has a unique reference; if the same one arrives twice (Paystack sometimes retries), the second one is quietly ignored.
- **A hiccup never swallows a payment.** If anything unexpected goes wrong mid-payment, the engine deliberately asks Paystack to try again later, rather than pretending it succeeded. Paystack keeps retrying for up to 72 hours.

---

## The "locks" — trials, plans, and read-only

Access is governed by **two independent questions**:

- **Does your *plan* include this feature?** Starter, Standard, and Premium unlock different things. A Starter school can't reach Premium features like fees or the parent portal.
- **Is your *subscription* still alive?** A 14-day free trial ends hard. A paid month gets 3 extra "grace" days after it lapses, then the school becomes **read-only**: it can still *view* everything it created, but can't create new things until it pays again.

Right now these locks are in **"watch mode."** They quietly note what they *would* block, but let everything through. This is on purpose: the locks stay dormant until the very first real payment proves the money path works end to end. Only then do we switch them to **"enforce."** The rule is simple — *never hang the lock before the door opens*, so no school is ever locked out with no way to pay.

**Comped schools** (for example, a pilot school we've given the product to for free) are set to "free forever" and keep full access even after the locks enforce.

---

## Who can do what (the roles)

- **Super admin** — us. Approves schools, suspends them, sees platform-wide numbers.
- **School admin (principal)** — runs one school: teachers, classes, students, results, fees, settings.
- **Teacher** — sees only their own assigned classes and subjects, and is the only role that generates AI content.
- **Bursar** — a finance-only role that sees fees and nothing else sensitive.
- **Parent / student (portal)** — an outside-the-staff login to view a child's results, attendance, and fee status. View-only by nature.

---

## Getting it running (for whoever sets it up)

This engine is a Node.js program. Someone technical sets it up once on a machine; after that it runs itself on the server. Here's the whole local setup in plain steps — each boxed line is a command typed into a terminal.

**You need first:** Node.js (version 20 or newer) and PostgreSQL (the database) installed on the machine.

**1. Get the code's building blocks.**
```
npm install
```
This downloads everything the engine depends on.

**2. Create an empty database** for it to use:
```
psql -U postgres -c "CREATE DATABASE klassrun_db;"
```

**3. Set up the secrets file.** Copy the example, then fill in two things — the database address (`DATABASE_URL`) and a random secret used to sign logins (`JWT_SECRET`):
```
cp .env.example .env
```
The AI and payment keys can stay blank for basic local work.

**4. Build the tables and starter data:**
```
npx prisma migrate dev
npm run db:seed
npm run db:seed:super-admin
```
The last line creates your own top-level admin account (it reads your details from the secrets file).

**5. Start it:**
```
npm run dev
```
It listens on **port 4000**. To confirm it's alive, open `http://localhost:4000/api/health` in a browser — it should reply `{"status":"ok"}`.

**On the real server it's simpler.** The engine lives on **Render** and **redeploys itself automatically** whenever new code is pushed to the `main` branch — no manual steps. The database is **Neon**. Any new setting has to be added on the Render dashboard *before* the new code goes live, or the engine boots in a broken state.

> **One Nigerian-ISP quirk worth knowing:** some networks (notably MTN) block the port the database normally uses. When that happens, database updates are applied by hand through Neon's web-based SQL editor instead of the usual command. This is expected, and the technical team has the exact steps.

---

## Where it lives and how it's kept safe

- **Hosting:** the engine runs on **Render**; the database is **Neon** (PostgreSQL). The parent portal, AI, email (Resend), and image hosting (Cloudinary) are all wired in.
- **Passwords** are never stored as-is — they're irreversibly scrambled (hashed).
- **Logins** are proven with a signed token that lives in a secure cookie the browser's own scripts can't read.
- **Nothing is ever truly deleted** — records are marked hidden ("soft delete") so mistakes are recoverable and history survives.
- **An audit trail** records logins, invites, and every AI generation, separately from the main data, so it survives even if a record is removed.

---

## Contact

- **Website:** klassrun.com · **Email:** info@klassrun.com
- **Company:** Klassrun Technologies Ltd · RC 9463863 · Lagos, Nigeria
