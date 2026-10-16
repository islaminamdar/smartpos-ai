# Kitchen station workflow

Candidate implementation extends the existing restaurant counter. The manager editor and unified station board have been rendered with synthetic fixtures at 320px, 375px and 1280px. Customer activation remains pending. See the [configuration contract](../contracts/20261016-kitchen-stations.md), [workflow contract](../contracts/20261016-kitchen-station-workflow.md) and [manager guide](../operations/kitchen-stations.md).

## Purpose and visual direction

Give each kitchen worker an accurate view of their station without losing changes, withdrawals or unassigned work. Keep the existing Kitchen navigation and the branch name visible. Use the inherited counter typeface with dark green `#20362d`, action green `#235b42`, white, selected-work tint `#edf6ef`, attention amber `#9e7318` and stop red `#842923`. The final visual pass uses green preparation controls within the existing counter chrome, with blue keyboard focus. Station identity uses names, not colours already reserved for preparation state. Hierarchy comes from order references, quantities and clear actions; avoid decorative summary cards.

Use one labelled station select for the unified routed paid/unpaid board; retain separate legacy boards below for previously sent work. Default to All stations, with General for unassigned work. The review rejected a filter-only implementation: existing actions affect whole tickets or stage buckets. Do not label an action “Start Grill items” until its server command enforces exactly that station's scope.

## Manager setup

The manager-only **Kitchen stations** navigation opens an in-page editor within the branch counter. Managers create, rename, archive or reactivate stations. Search products and assign a station or General; keep these edits separate from unsaved menu prices/photos. Saving uses the exact durable request and confirms only its matching acknowledgement. Uncertain saves remain visible for recovery; changing branch/account cannot adopt another actor's request.

Explain the effect beside the editor: “Changes apply to future kitchen work. Existing preparation stays where it was sent.” Archiving requires clearing/reassigning current product routes first. Existing preparation and history remain associated with the original station, including archived stations with unfinished work. Do not imply that archiving recalls food or deletes history.

## Kitchen use

Desktop structure:

```text
Kitchen at Branch                         Manage stations
Kitchen station [All stations]            Last confirmed / Refresh
General work: 2 tickets                   Changes needing review: 3
Return and withdrawal attention
Sent orders                              Paid orders
[station quantities and scoped actions]  [station quantities and scoped actions]
```

The example counts are illustrative, not seeded restaurant data. Use authoritative full counts, not the currently loaded page. Counts describe tickets; never sum pieces and kilograms into an item total. Selected-station cards retain the order/table reference, service type, paid/unpaid state and elapsed time. Show when other stations also have work on the order. Keep prices and customer details out of preparation screens.

General work and a branch-wide attention indicator remain visible outside the selected filter. A station whose final line was withdrawn must still see its pending notice. Detail views show the entire content being acknowledged and the exact station obligation; a filtered line subset must not acknowledge unseen work elsewhere. Changing station resets pagination and confirmation prompts while leaving pending mutation recovery visible. Stale/unavailable reads show their state rather than an empty queue. Polling preserves focus and open details.

At 375px, stack branch heading, full-width select, attention links and single-column tickets. Use 48px controls, labelled native selects, visible keyboard focus, text alongside colour, wrapping long names and polite save announcements. Avoid horizontal station pills, clipped tables and floating actions covering content. Verify at 320px, 375px and desktop before release.

## Integration and acceptance

Implemented components are `KitchenStationManager` and `StationWorkBoard`, integrated through the `LiveCounter` account/counter recovery boundary. The unified board handles routed paid and unpaid work; existing boards retain pre-routing work. Station preparation and notice actions use the authoritative scoped APIs. All stations is an overview, not permission to silently move every station's work.

Acceptance covers mixed-station orders, fully withdrawn lines, archived stations, served quantities plus additions, payment promotion, partial/final returns, stale responses, changed branch/account, uncertain saves, complete pagination, keyboard use and actual responsive overflow checks. Station selection is a viewing preference, not a separate staff authorization role. Printer routing remains a separate physical acceptance item.
