# Reports rendered review — 16 October 2026

Reviewer: Reporting Engineer; model runtime-selected/not exposed.

## Scope and environment

Reviewed the production-built counter at `http://127.0.0.1:3049/counter` in a separate Chrome tab using CUA. The preview backend was deliberately unavailable and financial writing disabled. Only that tab's bootstrap/report Fetch/XHR responses were fulfilled with a sanitized synthetic fixture produced by the SQL test. No customer credentials, real customer records or financial mutations were used.

This verifies the rendered UI and its interaction with controlled API responses, not a live browser-to-database round trip. The parent separately reported a real authenticated, read-only zero-document report after migration application; that is not substituted for nonzero UI testing here.

## Verified observations

| Check          | Result                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop 1280px | Clear cards, filters and tables; no outer horizontal overflow (1265px document with scrollbar).                                                                                                                                  |
| Mobile 375px   | No outer overflow; six counter tabs wrap into two rows and remain 44px high.                                                                                                                                                     |
| Mobile 320px   | Document scroll width exactly 320px; cards, long branch name, warning and date controls fit.                                                                                                                                     |
| Table overflow | Contained within labeled, keyboard-focusable regions. At 320px day table 262/666px, payments 262/308px, VAT 262/394px, products 262/573px. Actual horizontal gesture moved the payments region 46px without moving the document. |
| Negative day   | AED6.00 sales, AED10.50 refunds, net −AED4.50, net excluding VAT −AED4.00 and VAT −AED0.50 rendered correctly.                                                                                                                   |
| Two-day range  | Native date keyboard interaction and reload requested 15–16 October; AED27.00 sales, AED21.00 refunds, AED6.00 net and zero net VAT.                                                                                             |
| Coverage       | One excluded older order is visibly warned about; Dubai date boundaries and recorded-card limitations are explained.                                                                                                             |
| Product search | “Weighted” filters to one weighted item, quantity 0.5kg and stored AED10.50 amount.                                                                                                                                              |
| Export         | Link contains the verified branch and exact 15–16 October date range plus `format=csv`. CSV content and injection escaping are covered by API/unit tests.                                                                        |
| Keyboard       | Date day-segment change works; table regions receive a visible blue focus outline.                                                                                                                                               |
| Browser errors | No console errors or warnings during the successful report checks.                                                                                                                                                               |
| Timeout        | After the preview stopped, the outstanding report timed out, removed prior totals/export, and re-enabled retry. The visible browser-native “signal timed out” wording is a minor remaining copy improvement.                     |

Native screenshots were captured and visually inspected in the CUA tool transcript at desktop and both mobile widths. They were not exported to local image files; no screenshot file paths are claimed.

## Limits and release assessment

No visual code changes were required. CSV download through a real authenticated backend, maximum-volume performance and every keyboard path were not exercised in this browser pass. An explicit HTTP503 fixture was not completed after preview termination, but the real outstanding request timed out visibly without false zero totals. Automated API/UI tests additionally cover failed and unauthorized results. The final production build and deployment remain the parent engineer's separate release steps.

Reporting validation completed before handoff: nine unit/API/UI tests passed, disposable PostgreSQL integration passed, TypeScript passed, and scoped Semgrep reported zero findings with complete parsing. Scoped ESLint had no errors and one reviewed hook-cleanup ref warning for the request-generation cancellation guard.

## Follow-up timeout correction

The timeout now asks the manager to check the connection and retry, with totals explicitly unavailable. A DOMException does not consistently inherit from the same `Error` constructor across browser/test realms, so the handler checks its name structurally. The new regression first failed on that boundary, then passed after correction. All four reporting UI tests pass, including timeout → retry → verified report, with no stale totals or export while the failed request is unresolved. No layout/style change was made.
