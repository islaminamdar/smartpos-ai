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
