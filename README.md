# TechLoop Operations

Phase 1 prototype for the TechLoop operational platform. The workspace contains:

- `services/api`: Express + TypeScript API with Mongoose models, JWT authentication, role checks, listing review, offer creation, pickup assignment, pickup events, handover, audit logging, and AI health probing.
- `apps/admin`: Vite + React + TypeScript company operations dashboard.
- `apps/delivery`: Vite + React + TypeScript delivery partner web portal.

## Local setup

1. Install Node.js 20 or newer and MongoDB.
2. Copy `.env.example` to `.env` and set `MONGODB_URI` and a strong `JWT_SECRET`.
   Set `AUTHORIZED_ADMIN_EMAILS` to a comma-separated list of the exact email
   addresses allowed to use staff or super-admin accounts. Admin access is never
   granted from an email domain or a frontend role selection.
3. Install packages:

   ```powershell
   npm.cmd install
   ```

4. Seed the demo staff account and one review-queue listing:

   ```powershell
   npm.cmd --workspace services/api run seed
   ```

5. Run the API and admin app in separate terminals:

   ```powershell
   npm.cmd run dev:api
   npm.cmd run dev:admin
   ```

6. Start the delivery partner web portal:

   ```powershell
   npm.cmd run dev:delivery
   ```

### Git Bash / VS Code terminal

The admin demo can be started from one Git Bash terminal. In VS Code, select
**Terminal → New Terminal**, choose **Git Bash** from the terminal profile selector,
then run:

```bash
cd /c/Users/devansh/OneDrive/Desktop/techloop
npm install
npm run dev:demo
```

The launcher seeds MongoDB and starts both the API and admin interface. Open
`http://localhost:5173`. Stop both services with `Ctrl+C`.

To start the delivery partner web portal in a second Git Bash terminal:

```bash
cd /c/Users/devansh/OneDrive/Desktop/techloop
npm run dev:delivery
```

If the Vite cache needs to be refreshed, stop the portal with `Ctrl+C` and run:

```bash
npm run dev:delivery:clear
```

The npm scripts select the correct delivery web workspace.

The API uses `mongodb://127.0.0.1:27017/techloop` by default, so a local MongoDB
Windows service does not require a `.env` file for this demo. Environment variables
still override the defaults for deployment.

### Importing existing user-app data

If the customer app uses a separate MongoDB database, configure `USER_MONGO_URI`
and `USER_MONGO_DB` in `.env`, then run:

```powershell
npm.cmd --workspace services/api run migrate:user-data
```

The migration is non-destructive and idempotent. It reads existing customer users,
catalog items, and sell orders from the user-app database, matches customers by
email, creates missing customer accounts and operational listings, and links each
imported order to its legacy listing. Existing target records are not deleted or
overwritten. Imported accounts receive a random bcrypt password hash and must use
the normal password-reset flow before password login.

Demo credentials:

- Admin: `ops@techloop.local` / `demo-password`
- Delivery partner: `partner@techloop.local` / `demo-password`

Public signup creates customer accounts only. Staff, delivery-partner, and
technical-partner accounts must be created by an authorized administrator.
Passwords are stored as bcrypt hashes and are never shown in the admin portal.
Internal account email changes require verified ownership; use the admin
password-reset action to set a new password without viewing the old one.

The admin runs at `http://localhost:5173`, the delivery portal at `http://localhost:5174`,
and the API runs at `http://localhost:4000`.
For a physical device running Expo, set `EXPO_PUBLIC_API_URL` to an address reachable from
the device instead of `localhost`.

## Current workflow

The seeded listing can be reviewed in the admin dashboard, manually assigned to an active
delivery partner from the listing detail drawer, and then advanced through pickup events in
the delivery partner portal. Approval does not automatically assign a partner in Phase 1:
operations explicitly chooses the partner, pickup window, and instructions. Once assigned,
the same MongoDB-backed pickup assignment is immediately visible to that partner after
refreshing the delivery portal. The API records status history and audit entries and applies
delivery-partner authorization to assignment access.

The remaining production work includes payment-provider reconciliation, points and reward
ledger endpoints, inspection/processing records, private object storage, real YOLO multipart
forwarding, push notifications, and the remaining moderation/analytics screens. These are
intentionally not represented as successful demo actions.

### Listing lifecycle persistence

Each listing/order stores independent workflow flags rather than account-level flags:

- `pickup` becomes `true` only when an authorized delivery partner or operations user
  records `Collected` or `Handed Over`.
- `verified` becomes `true` only when an authorized staff user accepts the inspection.
- `paid` becomes `true` only after the verified payment workflow reconciles the wallet
  and carbon ledger.

Scheduling or assigning a pickup does not mark it as picked up. Payment requires a
verified inspection, and repeated pickup/payment requests are guarded against duplicate
events or credits. The legacy `Listing` and source-compatible `SellOrder` records are
updated together through the existing `legacyListingId` relationship.
