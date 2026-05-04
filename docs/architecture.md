# Klassrun System Architecture

This document describes how Klassrun's three repositories fit together,
how requests flow through the system, and where every piece is deployed.

When the architecture changes, **update this file in the same PR**.

---

## High-level system

```mermaid
flowchart TB
    subgraph users["Users"]
        principal["School Principal"]
        teacher["Teacher"]
        super["Super Admin"]
    end

    subgraph dns["Namecheap DNS"]
        dns_apex["klassrun.com"]
        dns_app["app.klassrun.com"]
        dns_wild["*.klassrun.com"]
        dns_api["api.klassrun.com"]
    end

    subgraph vercel["Vercel"]
        web["klassrun-web<br/>marketing site"]
        app["klassrun-app<br/>auth + portals"]
    end

    subgraph railway["Railway"]
        api["klassrun-api<br/>Express + Prisma"]
        db[("PostgreSQL")]
    end

    subgraph external["External services"]
        anthropic["Anthropic API<br/>(AI generation)"]
        paystack["Paystack<br/>(payments)"]
        vercel_api["Vercel API<br/>(provision subdomains)"]
    end

    principal --> dns_apex
    teacher --> dns_wild
    super --> dns_app

    dns_apex --> web
    dns_app --> app
    dns_wild --> app
    dns_api --> api

    web -.->|"signup CTA links to"| app
    app -->|"REST + JWT"| api

    api --> db
    api -->|"generate content"| anthropic
    api -->|"billing webhooks"| paystack
    api -->|"add subdomain on signup"| vercel_api
```

---

## Repository layout

| Repo | Domain(s) | Purpose | Stack |
|---|---|---|---|
| **klassrun-web** | `klassrun.com` | Marketing site, SEO, lead capture | Next.js, shadcn/ui, Tailwind v4 |
| **klassrun-app** | `app.klassrun.com`, `*.klassrun.com` | Auth, super admin, school portals | Next.js |
| **klassrun-api** | `api.klassrun.com` | Backend, AI, billing, all data | Node.js, Express, PostgreSQL, Prisma |

The three repos are intentionally **separate** for independent deploys and
clean boundaries. They communicate over HTTPS REST with JWT bearer tokens.

---

## Multi-tenant request flow

This is what happens when a teacher visits `greenfield-academy.klassrun.com/dashboard`:

```mermaid
sequenceDiagram
    participant Browser
    participant DNS as Namecheap DNS
    participant Vercel as Vercel Edge
    participant MW as Next.js Middleware
    participant API as klassrun-api
    participant DB as PostgreSQL

    Browser->>DNS: greenfield-academy.klassrun.com
    DNS->>Vercel: CNAME *.klassrun.com → Vercel
    Vercel->>MW: route to klassrun-app

    MW->>MW: extract slug "greenfield-academy"
    MW->>API: GET /schools/by-slug/greenfield-academy
    API->>DB: SELECT * FROM schools WHERE slug = $1
    DB-->>API: { id, status, ... }
    API-->>MW: school context

    alt status = ACTIVE
        MW->>MW: validate JWT (must contain matching schoolId)
        MW->>Browser: render dashboard scoped to school
    else status = EXPIRED
        MW->>Browser: redirect to billing page
    else school not found
        MW->>Browser: 404
    end
```

### The critical isolation principle

**Tenant isolation is enforced at the data layer, not the UI layer.**

Every query through Prisma must include `schoolId` in the `where` clause.
The scoped Prisma client (`src/lib/db.js`) auto-injects this from the
authenticated request context. If a developer ever forgets to scope a query,
the scoped client throws an error rather than returning unscoped data.

A leaked query is a security incident. An error is a development bug.
We choose bugs.

---

## Authentication

```mermaid
flowchart LR
    signup["School signup<br/>(app.klassrun.com)"] -->|1. create school + admin user| api1["klassrun-api"]
    api1 -->|2. provision subdomain| vercel_api["Vercel API"]
    api1 -->|3. issue JWT with<br/>userId, role, schoolId| signup
    signup -->|4. redirect to| portal["greenfield.klassrun.com/welcome"]

    portal -->|every request carries JWT| middleware["Subdomain middleware"]
    middleware -->|validate JWT.schoolId<br/>matches subdomain school| allowed["Allow request"]
    middleware -->|JWT mismatch| forbidden["403 Forbidden"]
```

**JWT contents:**

| Claim | Value | Used for |
|---|---|---|
| `userId` | UUID of the authenticated user | Identifying who is making the request |
| `role` | `SUPER_ADMIN`, `SCHOOL_ADMIN`, or `TEACHER` | Authorization checks |
| `schoolId` | UUID of the user's school (null for SUPER_ADMIN) | Tenant isolation |

A teacher's JWT for Greenfield cannot be reused on Sunrise's subdomain — the
middleware refuses it.

---

## External integrations

### Anthropic API (AI generation)

- Used by: `klassrun-api` only
- Authenticated via: API key in environment variable `ANTHROPIC_API_KEY`
- All requests go through `src/ai/` modules with education-only system prompts
- Rate limiting and cost tracking handled at the `klassrun-api` layer

### Paystack (payments)

- Used by: `klassrun-api` only
- Webhook endpoint: `api.klassrun.com/webhooks/paystack`
- Handles trial conversion, renewal, payment failures, cancellations

### Vercel API (subdomain provisioning)

- Used by: `klassrun-api` during school signup
- Calls `POST https://api.vercel.com/v10/projects/{projectId}/domains` to add
  `{slug}.klassrun.com` after a school signs up
- Required while we're on Vercel free tier (50-domain ceiling)
- Will be replaced by wildcard SSL when we upgrade to Pro

---

## Deployment topology

| Component | Hosted on | Free tier OK? | Notes |
|---|---|---|---|
| klassrun-web | Vercel | Yes | Static + SSR, low traffic |
| klassrun-app | Vercel | Yes (up to 50 schools) | Wildcard subdomains; needs Pro after 50 |
| klassrun-api | Railway | Yes (early) | Express + Prisma; scales with traffic |
| PostgreSQL | Railway | Yes (early) | Will need upgrades around 100+ schools |
| DNS | Namecheap | Yes | Wildcard CNAME `*` → `cname.vercel-dns.com` |

---

## Updating this document

When you change architecture:

1. Update the relevant Mermaid block above
2. Add new external services to the "External integrations" section
3. Update the "Deployment topology" table if hosting changes
4. Commit alongside the code change in the same PR

The diagrams here render natively on GitHub. View them by clicking the file
in the repo browser, or in any Markdown viewer that supports Mermaid (Notion,
Obsidian, VS Code with the Markdown Preview extension).
