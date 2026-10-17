# Staff access for the first restaurant

## What is available

The existing Bur Dubai manager can continue using the website counter. Managers can review and change cashier access for their branch, invite existing verified accounts, and deactivate access with a reason. Each signed-in person can change their own password after entering their current password and closing their shifts.

An invitation is a branch-access link, not an authentication account or password reset. Creating or copying a link does not send an email. The screen reports this explicitly.

## Adding a cashier

1. Collect the person's name, their own email address and their branch. Do not ask them to send a password.
2. Have the platform administrator arrange and verify their individual authentication account. **New-account self-service is not enabled in the current release.** Do not claim an account is ready until the administrator has checked it.
3. Sign in as the branch manager, open **Staff**, choose **Invite staff member**, and enter the name, email and reason. A manager's invitation is limited to cashier access at that branch.
4. After the application confirms the invitation, privately give the displayed link to that person. Keep it out of group chats and public pages.
5. The person opens the link on their own device and signs in with their verified account to accept branch access. They should not accept while another cashier has an active shift or pending request in the browser.
6. At the counter, finish the previous cashier's work and shift, sign out, then sign in as the new cashier. Register that cashier's device binding and open their shift with the actual opening cash.
7. Confirm the correct branch and cashier before the first sale. Do not create dummy sales in the restaurant's accounts for training.

## Password assistance

**Forgotten-password email delivery is not configured.** A cashier who cannot remember their password must contact the platform administrator. Managers cannot view or reset another person's password from Staff. Do not share the manager password, create a duplicate identity or remove an existing account to bypass recovery.

A person who knows their password can use **Account → Change password**. First finish saved requests and close their shifts. A successful change requires sign-in again. If the result is uncertain, follow the on-screen instructions and check the new password rather than repeatedly submitting the change.

## Before changing or disabling access

Resolve outstanding counter requests and close the person's open shifts. Changing branch access does not erase historical bills. If access must be restored to recover an original pending request, restore the existing membership rather than creating another account. Keep the original browser/device data until recovery is confirmed.

## Remaining platform work

The auth service was checked read-only on 17 October 2026: sign-up is disabled, email auto-confirm is disabled, and no SMTP transport is configured. The current help screen intentionally describes this limitation.

To enable self-service account setup and forgotten-password recovery, configure a recipient-only email transport, restrict verification/recovery return URLs, implement the separate invitation and recovery continuations, and verify rate limits, identity binding, expiry, replay protection and real delivery with designated test recipients. An operator must separately authorise any test messages sent to real addresses. Do not enable auto-confirmation as a shortcut for email ownership or expose provider recovery tokens to a manager.

## Prepared recipient verification flow — 17 October 2026

A separate, default-off new-account flow is implemented. It is not enabled merely by deploying the website or adding an invitation. Existing verified-account invitation acceptance and password changes continue unchanged.

When enabled, the invitation recipient opens the link in their own signed-out browser and chooses **Send my verification code**. The server checks the invitation, inviting manager's current authority, branch status and request limits. Only the invited inbox receives an Auth-generated one-time code. The manager receives neither this code nor any authentication link. The recipient enters the code and chooses their own password; only a matching provider verification and the existing branch acceptance transaction complete setup. The system does not auto-confirm an email, change an existing confirmed account's password, or email anyone when a manager merely creates a branch invitation.

A request acknowledgement means the mail transport accepted submission, not that the recipient's inbox received it. Each invitation permits one setup request per minute, plus source/email authentication budgets. A completion attempt is consumed atomically before contacting Auth, and blocks resends for two minutes; concurrent completions cannot overwrite one another’s password. Incorrect codes do not consume the attempt. Provider failures or uncertain results retain the consumed attempt and require the displayed sign-in/recovery checks. A new request invalidates the prior application attempt. Codes and provider sessions are never returned in the API response, URL, local storage, staff history or command journal. The only persisted code material is a hash bound to the high-entropy application invitation secret.

Server configuration (private environment, never repository secrets):

- `POS_STAFF_ACCOUNT_SETUP=true`
- `POS_STAFF_MAIL_FROM`: one verified sending email address.
- On the reviewed hosting server, `POS_STAFF_MAIL_TRANSPORT=local-smtp` uses only `127.0.0.1:25` with no TLS or external host override. The local MTA handles onward delivery and DKIM. Keep the app service hardening enabled; this avoids relying on a setuid sendmail process.
- Alternatively `POS_STAFF_MAIL_TRANSPORT=sendmail` and `POS_STAFF_SENDMAIL_PATH=/usr/sbin/sendmail` (or `/usr/lib/sendmail`), or `POS_STAFF_MAIL_TRANSPORT=smtp` with `POS_STAFF_SMTP_HOST`, `POS_STAFF_SMTP_PORT` (`465` or `587`), `POS_STAFF_SMTP_USER`, and `POS_STAFF_SMTP_PASSWORD`. SMTP requires TLS and normal certificate verification.
- Apply migration `20261017003300_pos_staff_account_setup.sql`. The new setup table/functions are inaccessible to anonymous or authenticated clients; only the server's service role can validate/claim/bind an attempt. Normal invitation acceptance still runs as the verified recipient.

Before enabling: verify the configured sender/domain and transport, test the migration and deployed Auth provider in an isolated synthetic environment, test new-account setup/resend/expired code and revoked invitations, and check the page at desktop and mobile widths. No real email sends are authorised merely by this implementation. Record transport acceptance and actual recipient delivery separately when a designated live email test is authorised.

If code verification succeeds but password setup is unconfirmed, do not repeatedly request codes or assume access. Try signing in with the chosen password; if that fails, contact the administrator. If the password was set but branch acceptance was not confirmed, use the existing **Sign in and accept invitation** action with that password. An account with verified email but no confirmed password may require administrator recovery. Forgotten-password self-service remains a separate unfinished feature; this setup flow must never be used to reset an existing confirmed account.
