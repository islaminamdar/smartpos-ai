# Kitchen station workflow

Design direction reviewed against the existing restaurant counter. This is not a rendered or delivered screen. The configuration foundation is defined in the [station contract](../contracts/20261016-kitchen-stations.md); the editor and station-scoped preparation/notice workflow remain pending.

## Purpose and visual direction

Give each kitchen worker an accurate view of their station without losing changes, withdrawals or unassigned work. Keep the existing Kitchen navigation and the branch name visible. Extend the current Arial/Noto Sans type system and operational palette: navy `#142d4e`, action blue `#165dcc`, white, canvas `#f4f7fb`, attention amber `#744609` and stop red `#812b22`. Station identity uses names, not colours already reserved for preparation state. Hierarchy comes from order references, quantities and clear actions; avoid decorative summary cards.

Use one shared, labelled station select above both existing kitchen families. Default to All stations, with General for unassigned work. The review rejected a filter-only implementation: existing actions affect whole tickets or stage buckets. Do not label an action “Start Grill items” until its server command enforces exactly that station's scope.

## Manager setup

Kitchen → Manage stations opens an in-page editor with a Back button and branch identity. Managers create, rename, archive or reactivate stations. Search products and assign a station or General; keep these edits separate from unsaved menu prices/photos. Saving uses the exact durable request and confirms only its matching acknowledgement. Uncertain saves remain visible for recovery; changing branch/account cannot adopt another actor's request.

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

Planned components: `KitchenStationToolbar`, `KitchenStationManager` and a shared attention tray, integrated through the existing `LiveCounter` scope/recovery boundary. These names are a plan, not existing implementation claims. Both paid and unpaid boards require authoritative scoped stage and notice APIs first. All stations is an overview, not permission to silently move every station's work.

Acceptance covers mixed-station orders, fully withdrawn lines, archived stations, served quantities plus additions, payment promotion, partial/final returns, stale responses, changed branch/account, uncertain saves, complete pagination, keyboard use and actual responsive overflow checks. Station selection is a viewing preference, not a separate staff authorization role. Printer routing remains a separate physical acceptance item.
