# Staff access and account setup — proposed UX

16 October 2026 · UI/UX Engineer · model runtime-selected/not exposed

**Status:** first-release contracts are confirmed in the final section and UI components are prepared for integration/testing. Email-based new-account setup and recovery below remain future design. No invitations, email, accounts, passwords or production access were changed by this design/UI work.

## Product boundary

Managers manage cashier access to their own branch. They never choose or receive an employee's password, authentication login link, email-verification secret or password-recovery secret. A manager may copy an **application invitation link**, which grants no authentication session: the recipient must prove the invited email identity before accepting branch membership.

An existing account signs in and accepts the invitation without changing its global password. A new account chooses its own password and verifies its email through a message delivered only to the recipient. SMTP configuration/delivery is being checked separately. Sending email and activation of email-dependent flows remain blocked until authorised and configured; this design does not authorise sending a message.

Account recovery belongs to the recipient's verified email channel. Replacing a branch invitation must never become a shortcut for password recovery. Own-password change requires the current password to be verified again.

## Existing design and source constraints

- `components/pos/LiveCounter.tsx` currently has seven tabs, role-based manager tools, a branch-details screen and a sign-out button. Its pending-request banner blocks another payment and local sign-out; another staff member's open shift cannot be silently taken over.
- `app/counter/counter.css` supplies navy/blue branding, white controls, pale backgrounds, visible focus outlines and 44px minimum buttons. Use these rather than adding a separate account-management theme.
- `app/api/pos/session/route.ts` accepts a normal counter login only after successful authentication **and existing active POS membership**. Therefore, ordinary counter sign-in alone cannot accept an existing authentication account's first branch invitation. A narrowly scoped invitation sign-in continuation is needed; do not weaken normal counter login globally.
- `lib/pos/server/client.ts` stores authentication in HttpOnly cookies and binds device cookies per user. Access flows must preserve these actor boundaries. Changing the person signed in does not transfer a counter binding or pending request.
- Browser journals retain unresolved financial requests. The server can see open shifts and committed actions, but cannot prove that every browser received its acknowledgement. Do not label an employee “safe to remove” solely because no open shift is found.

## Navigation and layout

Keep the seven counter tabs. Under **Branch**, add two compact destinations:

1. **Staff access** — managers/owners only; subtitle “Cashiers for this branch.”
2. **Your account** — every signed-in staff member; shows their own email, current branch role and **Change password**.

Use an in-counter subview with **Back to branch** for staff management. Account setup/recovery uses a dedicated narrow page so a link opened on a personal phone does not resemble a sales counter. No automatic enrolment or shift opening follows acceptance.

Desktop: staff list on the left and selected-person detail on the right; invitation form about 520px wide. Mobile 320–375px: one stacked list of names/emails, state and one main action; selecting a person opens a full-width detail view with a clear back button. Avoid a horizontally scrolling permissions table. Buttons and checkbox label targets remain at least 44px high, all fields have persistent labels, and keyboard focus moves to the result/error heading after submission. Long email addresses wrap without breaking the page.

## Manager: staff list and invite

Page heading **Cashiers at [branch]**. Explain: “Cashiers can sell and manage their own counter shifts. Managers handle menu changes, offers, reports and refunds.” Search by name/email; filters **All / Active / Inactive / Invitations**. Show only branch-scoped cashier memberships and relevant invitations, not a global user directory.

Each cashier row shows display name, email, **Active** or **Inactive**, and **View access**. An open shift may show “Shift open on [counter]” from server state. Each invitation shows intended email, expiry and its own state. Do not conflate a pending invitation with an active staff account.

**Invite cashier** form:

- Name for this branch, email, fixed role **Cashier** and explicit branch name.
- No role dropdown for manager/owner, password field or “email sent” claim.
- Submit label **Create invitation**. Before submitting: “You will receive a private invitation link to give this person. They sign in or verify their email to accept it.”
- On confirmed creation: **Invitation created — not sent**; show recipient, branch, expiry, and **Copy invitation link** in a one-time result panel.
- Clipboard success means only **Link copied**, never “Delivered,” “Invited successfully” or “Account ready.” Failure means “The link could not be copied. Select and copy it here.” Show the application link only in this result panel, never a password or provider authentication secret.
- New-account email setup unavailable: “Existing account holders can sign in to accept. New account setup is waiting for email service configuration.” Do not imply that creating the invitation created a usable account.

Link availability and invitation status are separate. A valid invitation can be **Awaiting acceptance** even after its one-time link is no longer visible. Offer **Replace invitation link**; explain that the old invitation link stops working. Replacement must be atomic and must not reset an account password. Copying, revoking and replacing links are explicit manager actions; no automatic email/share action.

## Manager: edit access

Detail screen shows branch, cashier role, current membership revision, active/inactive state and known open shifts. Allow branch display-name correction and **Deactivate cashier** / **Reactivate cashier**, with a short required reason for the access change. Keep historical cashier identity and receipts intact.

Confirmation is specific: “Deactivate [name] at [branch]? They will no longer be allowed to start new work here. Existing sales and receipts stay saved.” Do not offer “Delete account.” A branch change cannot disable the person's access to other tenants or reset their authentication account.

Managers may manage cashiers only, including cashiers created by another authorised manager. They cannot alter their own manager membership, another manager, an owner or a different branch. The confirmed owner contract additionally permits cashier/manager role and scope management; owner rows remain read-only and ownership transfer is excluded. Managers get no role dropdown; owners get only the cashier/manager options permitted by the server. Existing same-organization membership conflicts prevent a silent move through a new invitation.

If the last-known revision changed, display **Access changed elsewhere** and reload before another edit. If an action is unconfirmed, preserve its request number and pause that person's actions; never optimistically turn the row green/inactive.

## Invitation recipient — current boundary and future completion

Confirmed entry: `/staff/accept` with an opaque application-invitation token, never an authentication token. Put the token in the URL fragment, consume it into memory and remove it from the visible URL immediately using history replacement before loading any third-party content. Exchange it through a same-origin POST for a short-lived HttpOnly invitation challenge. No analytics, referrer forwarding, token-bearing query string, logs, browser-storage journal or application activity history on this flow. Raw invitation tokens are bearer access to invitation metadata only, not proof of email identity. Browser/clipboard handling must not be presented as a guarantee that an externally shared link can never be copied.

Future recipient challenge flow, once a safe invitation-metadata endpoint exists: before authentication show validated invitation details only: **Join [restaurant] · [branch] as a cashier**, the intended email and expiry. The current release instead shows **Sign in and accept invitation** plus an honest new-account-unavailable explanation; it does not invent invitation metadata. The future flow may show both **Sign in to accept** and **Set up your account** without exposing whether an arbitrary email has an account. The server determines the permitted continuation for this invitation, not a browser-selected email.

### Existing account

1. Email is fixed to the invitation; password uses `autocomplete=current-password`.
2. Invitation-scoped sign-in verifies the existing account and matching email without changing its password or granting unrelated counter access.
3. Review branch/role; choose **Accept branch access** explicitly.
4. Only a matching server acknowledgement shows **Branch access accepted**. Then **Open staff counter**; counter enrolment and shift opening remain separate.

If a different person is already signed in on this browser, do not silently replace them. Show “This browser is signed in to another account. Finish its saved requests before changing accounts, or open this invitation on your own device.” Never sign the manager out merely because they opened a copied link.

### New account

1. Invitation-bound email, own new password and confirmation; password policy comes from the configured server, with concise guidance next to the field.
2. The next action is explicitly **Send verification email** only once email delivery is enabled and authorised. Provider authentication/verification secrets go directly to this recipient, never to the manager or staff-list API.
3. After submission, distinguish **Email requested** from confirmed provider acceptance/delivery. Do not claim inbox delivery from an API success. Allow a rate-limited resend only through the same recipient-bound flow.
4. Verification returns through a dedicated callback and confirms the expected recipient. It does not auto-accept another invitation or silently join a different branch.
5. Review and explicitly accept the pending branch invitation. Account creation, email verification and branch acceptance are distinct states; an interruption can resume the incomplete step.

If an account already exists, preserve it and route to sign-in/recovery. Never overwrite an existing password or create a duplicate identity to bypass sign-in. Expired/revoked links say **This invitation is no longer available** and direct the person to their branch manager; no automatic replacement or email is sent.

## Your account and recovery

**Change password** shows the person's own account email, current password, new password and confirmation. New/confirmation fields use `autocomplete=new-password`; reveal controls are keyboard-accessible. Explain: “This changes your sign-in password for this account, including its other branches.” Do not present it as a branch password.

Require current-password re-verification against the same authenticated user immediately before update. Do not persist passwords in session/local storage, request journals, audit payloads, URLs, error diagnostics or activity history. Clear password fields after submission. A timeout is **Password change not confirmed**, not success; do not automatically retry or clear financial recovery records. Resume by verifying sign-in with the new password, using recipient recovery if necessary.

Place **Forgot password?** on staff sign-in and invite-scoped sign-in. It leads to recipient email recovery, not a manager-generated password. Until the email channel is configured/authorised, show “Password recovery is not available yet. Contact your administrator for setup assistance”; the application must not offer a manager-accessible recovery token as a fallback. When enabled, use a generic response such as “If this address has an account, recovery instructions have been requested” to avoid an account directory.

## Continuity rules requiring the final access contract

- Before own-password change, show and require resolution of a pending financial request in this browser. Warn about known open shifts; do not auto-close them, sign out, change device binding or delete local data. Session effects of a password update must be explicit in the server response and verified against the actual authentication provider.
- For ordinary cashier deactivation, reject with **Close the cashier's open shifts first** if the backend cannot safely support restricted closing after revocation. Never auto-transfer or silently close a drawer. An urgent security revocation requires a separate, explicit operator workflow.
- No-open-shift is not proof of no pending acknowledgement. After revocation, retain membership history, original device identity and immutable journals. The confirmed SQL contract allows narrowly scoped retrieval of already committed results for cleanup. An inactive cashier with an unsaved pending request needs explicit manager reactivation of that same identity before further recovery. Do not allow an inactive cashier to create a new sale through a recovery exception.
- If the manager's own browser has a pending sale, pause staff-access writes until it is resolved. Account switching must never replace another actor's pending request or enrol a new counter over the original binding.
- Every mutation needs an immutable request ID and authoritative status. Nonsecret access requests can retain a scoped recovery record; credentials, invitation raw tokens and passwords cannot be included. Final response-loss handling must separate **invitation exists** from **its raw link is still available**. If creation succeeded but the raw link cannot be recovered, first reconcile the invitation, then explicitly replace/revoke it; do not create duplicates blindly.

## Future interface expansion — subject to separate approval

This table captures the fuller design, including future challenge/email endpoints. The final section below supersedes it for the exact currently prepared implementation; no unused endpoint in this table is claimed to exist. All authenticated manager mutations require same-origin checks, branch permission and appropriate actor/device binding; all responses are private/no-store. Actor, role and branch authority come from the server.

| Surface | Proposed request | Required result/state |
| --- | --- | --- |
| Cashier list | `GET /api/pos/staff?branchId=…` | `branchId`, cashier memberships with stable ID/revision/name/email/active state, safe open-shift summaries, invitation metadata and allowed actions. No passwords/raw tokens/provider secrets. |
| Create invitation | `POST /api/pos/staff/invitations` with `id, branchId, deviceId, displayName, email, role, assignedBranchId, expiresAt, reason` | Matching request/invitation ID, expiry, `pending`, and one-time **application** link availability. The same request cannot create multiple invitations. |
| Revoke/replace invitation | POST command with `id, invitationId, branchId, deviceId, reason` to `/api/pos/staff/invitations/revoke` | Exact authoritative result; replacement revokes the prior application invitation atomically. No authentication-password effect. |
| Update cashier | POST command with `id, targetUserId, expectedRevision, branchId, deviceId, displayName, active, role, assignedBranchId, reason` | Matching membership revision, resulting access state and continuity outcome. No target role elevation/account deletion. |
| Exchange application link | `POST /api/pos/access/invitation` with in-memory `token` | Nonsecret invitation view and HttpOnly short-lived challenge; no login session or account-enumeration result. |
| Existing-account continuation | `POST /api/pos/access/sign-in` with password and invitation challenge | Authenticated matching identity restricted to invitation continuation until acceptance; no password reset and no forced replacement of another active actor. |
| Recipient setup | Recipient-only setup/verification endpoints, fixed invited email and short-lived challenge | Separate account-created, verification-requested, verified and membership-accepted states. Feature gated until email delivery is configured/authorised. |
| Accept invitation | `POST /api/pos/access/accept` with invitation challenge/request ID | Requires confirmed Auth email identity; matching active membership ACK. Expired/revoked/other-identity invitations fail closed. |
| Own password | `POST /api/pos/account/password` with current/new password | Current identity reverified; confirmed change plus actual session effect. No password-bearing idempotency journal. |
| Recipient recovery | Recovery request/callback/reset endpoints | Generic request response; recipient-only secrets, configured email channel and matching verified identity. No manager callback or secret return. |

Suggested common membership row: `{id, branchId, userId, displayName, email, role:'cashier', active, revision, openShifts, allowedActions}`. Invitation row: `{id, branchId, name, email, role:'cashier', status:'pending'|'accepted'|'expired'|'revoked', expiresAt, revision, linkAvailable:false}`. Track temporary UI states `saving`, `confirmation_needed` and `link_copied` separately; they are not durable membership states.

## Acceptance and handoff checklist

Before release, test a manager inviting a new recipient and an existing account, cross-tenant/manager/owner denials, wrong signed-in actor, duplicate/expired/revoked link use, recipient email verification and safe resend, same-request response-loss recovery, concurrent edits, open-shift deactivation and original-request recovery after access changes. Verify passwords/tokens never enter logs, activity views or local journals. Test password change against actual provider session behavior and distinguish provider acceptance from real email delivery.

Rendered review must cover 1280, 375 and 320px, long email/name wrapping, eight or more staff rows, all empty/error/pending states, keyboard focus, 44px targets, setup/recovery links with no exposed secrets, and a cashier who cannot see manager actions. Public release allowlists need explicit routes; existing legacy integrations stay blocked. No component implementation or production activation is implied by this document.

### Confirmed first implementation delta

GET staff also returns `actorRole`, `capabilities.inviteLinks` and `capabilities.emailDelivery:false`. Staff identity is `userId`; invitation state is `pending/accepted/revoked/expired`. Managers see branch cashiers only; owners see organization managers/cashiers plus read-only owners. Role, scope and deactivation changes are blocked while the target has open shifts; name-only edits remain possible.

Existing-account acceptance is one endpoint: `POST /api/pos/staff/invitations/accept {token,email,password}`. The page reads `#token=…`, scrubs the fragment and retains the application token only in memory. It verifies the invited existing account and accepts the invitation; no manager-visible provider auth secret is involved. New account creation, email verification and forgot-password delivery are not enabled in this first release. The invitation creation ACK returns a deterministic application `setupUrl`, so exact command retries can recover the same link without storing it in the browser journal. Raw setup URLs remain outside list/history responses.

Own password changes use `/api/pos/account/password` with current/new passwords and require sign-in again on confirmed success. The current browser must finish pending requests first; no password is stored in an immutable command journal. All remaining provider-email screens above are future design, not working capabilities.

## Implementation and rendered review — 2026-10-16

Prepared components: staff manager, existing-account invitation acceptance, own password change, and a restricted saved-request recovery panel when branch bootstrap is unavailable. Management journals are scoped to actor and branch, preserving the original device inside each frozen request. After reactivation or new enrolment, the same actor can check that original request through the historical-binding recovery endpoint. Passwords and invitation tokens never enter those journals. Permanent stale-revision/invalid-command responses refresh current access before another edit; uncertain results and open-shift conflicts retain the frozen request.

Initial local production build was reviewed with isolated Playwright contexts and synthetic API interception at 1280, 375 and 320 CSS pixels. Staff and Account navigation, invitation editing, identical-request retry after a simulated 503, keyboard password visibility control and fragment removal passed. Nine tabs wrap with 44px minimum heights. No horizontal document overflow or page exceptions were observed. No real account credentials or backend mutations were used.

Visual findings corrected in owned CSS: mobile list items were shrinking inside the bounded scroll panel and overlapping email/status text; children now retain their content height. Standalone invitation headings now have explicit size/spacing, and invitation history disclosure targets have 44px minimum height. A shared counter header home-link target measured 30–33px and was reported to the root engineer. Final rebuilt readback remains pending at this entry.

The unit suite covers24 cases across staff management, invitation/password handling and restricted financial-request recovery. Recovery validates exact request identity and matching invoice/credit-note identity before clearing IndexedDB; a foreign actor's credit note does not clear the journal. A server-confirmed cancellation explicitly requires reconciliation of any money already collected or returned. Inactive users with an unsaved request must have access restored by a manager. No new financial command, device enrolment or automatic sign-out is performed by recovery.

These are preparation and synthetic UI checks, not evidence of production activation, real recipient email delivery, a new-account onboarding flow or provider integration. Email verification and password recovery remain unavailable until recipient-only delivery is configured and tested.

Staff management recovery also requires an explicit checkbox authorising permanent cancellation if the original request was never saved. A matching server tombstone or original ACK is required before removal; access denial and a cancellation for the wrong command kind leave the journal untouched.

### Final rebuilt preview verification

Completed against the refreshed production build at `http://127.0.0.1:3049` on 2026-10-16, using new isolated headless Chromium contexts with intercepted synthetic API responses. Rechecked1280/375/320 widths. The corrected mobile cards retain full name/email/status height; invitation headings and spacing are clear; all nine tabs wrap without overflow. Measured document widths equal their viewport widths in staff, account, invitation and no-bootstrap recovery states. The staff/account/invitation control scan found no targets below44px (checkboxes excluded; their labels provide the larger target). Root's shared header home link now meets the target size.

Verified in the rendered app:

- A failed invitation write remains pending, retry sends exactly the original ID/body, and the explicit cancellation checkbox unlocks **Check saved change**. Recovery sends the original request unchanged and a matching cancellation clears the pending state.
- Password visibility works by keyboard. Invitation fragments disappear from the address bar. Existing-account-only and email-not-configured explanations remain visible. No invitation credentials were submitted in the browser review.
- With bootstrap unavailable, the original actor's real browser IndexedDB request is found. Simulated inactive403 leaves it intact and gives restore-access instructions. A subsequent matching committed ACK clears only that record; the only POST endpoint used is recovery. This was repeated at all three widths.
- No page exceptions occurred in the staff/account/invitation run. All browser contexts closed and their network interception removed with closure. No real account, database, payment or email operation was performed.

Private evidence is in `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/staff-ui-review/`: `results.json`, `recovery-results.json`, `manager-{width}.png`, `pending-{width}.png`, `resolved-{width}.png`, `account-{width}.png`, `accept-{width}.png`, and `recovery-{inactive|confirmed}-{width}.png`. Representative images at375 and320 were visually inspected along with the desktop manager screenshot. No material rendered blocker remains within this reviewed scope.

Final owned-source checks:24 targeted UI tests passed; TypeScript and scoped ESLint passed; Semgrep Community Edition ran210 rules across9 owned files with zero findings and approximately100% parsed lines. These do not replace the separate server/SQL/provider checks or a production rollout verification. New-account recipient verification and forgotten-password email recovery remain explicitly unavailable.
