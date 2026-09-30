## Prerequisites

- Node.js >=20 (Recommended)

## Installation

**Using Yarn (Recommended)**

```sh
yarn install
yarn dev
```

**Using Npm**

```sh
npm i
npm run dev
```

## Build

```sh
yarn build
# or
npm run build
```

## Security headers (`vercel.json`)

The production CSP and security headers live in `vercel.json` (JSON cannot carry comments, so the notes are here).

- **HSTS — re-evaluate `includeSubDomains` before binding a custom domain.** The current value is
  `max-age=63072000; includeSubDomains` (2 years). On a `*.vercel.app` host this only affects that host.
  Once a custom domain is attached, `includeSubDomains` makes every subdomain of it HTTPS-only for two
  years in every browser that has visited — including subdomains owned by other teams or not yet
  provisioned with TLS. Confirm all subdomains serve HTTPS (or drop `includeSubDomains`) before
  pointing a domain at this deployment. Do not add `preload` without the same review; preload-list
  removal takes months.
- **CSP `connect-src` is an allow-list.** `yarn build` fails if `VITE_SIGNAL_API_URL` points at an
  origin that is not in it (`src/lib/pepefi/cspConnect.ts`); `src/securityHeaders.test.ts` checks
  that the endpoints the code fetches are all listed.
- `style-src` keeps `'unsafe-inline'` because MUI / emotion inject `<style>` tags at runtime;
  `script-src` is `'self'` only.

## Mock server

By default we provide demo data from : `https://api-dev-minimal-[version].vercel.app`

To set up your local server:

- **Guide:** [https://docs.minimals.cc/mock-server](https://docs.minimals.cc/mock-server).

- **Resource:** [Download](https://www.dropbox.com/scl/fo/bopqsyaatc8fbquswxwww/AKgu6V6ZGmxtu22MuzsL5L4?rlkey=8s55vnilwz2d8nsrcmdo2a6ci&dl=0).

## Full version

- Create React App ([migrate to CRA](https://docs.minimals.cc/migrate-to-cra/)).
- Next.js
- Vite.js

## Starter version

- To remove unnecessary components. This is a simplified version ([https://starter.minimals.cc/](https://starter.minimals.cc/))
- Good to start a new project. You can copy components from the full version.
- Make sure to install the dependencies exactly as compared to the full version.

---

**NOTE:**
_When copying folders remember to also copy hidden files like .env. This is important because .env files often contain environment variables that are crucial for the application to run correctly._
