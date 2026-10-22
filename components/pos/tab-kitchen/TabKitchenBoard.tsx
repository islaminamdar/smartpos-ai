'use client'

import { browserUuid } from '@/lib/pos/browser-uuid'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  tabKitchenCommandSchema,
  tabKitchenDetailSchema,
  type TabKitchenCommand,
  type TabKitchenTicket,
} from '@/lib/pos/server/tab-kitchen'
import {
  tabKitchenCall,
  useTabKitchenCommands,
  TabKitchenPendingPanel,
  type TabKitchenScope,
} from './transport'
import { useTabKitchenList } from './useTabKitchenList'
import {
  stages,
  stageLabels,
  time,
  quantity,
  Metadata,
  PaymentBadge,
  ChangeList,
  changesBetween,
} from './presentation'
import styles from './tab-kitchen.module.css'
export { TabKitchenPendingRecovery } from './transport'
type Detail = z.infer<typeof tabKitchenDetailSchema>
type Stage = (typeof stages)[number]
type Props = TabKitchenScope & { branchName: string; deviceId: string }
export default function TabKitchenBoard(props: Props) {
  return <Board key={`${props.actorId}:${props.branchId}:${props.deviceId}`} {...props} />
}
function Board(props: Props) {
  const state = useTabKitchenCommands(props),
    list = useTabKitchenList(props.branchId, props.deviceId)
  const [history, setHistory] = useState(false),
    [detail, setDetail] = useState<{ data: Detail; pending: boolean } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState('')
  const [confirm, setConfirm] = useState<{
      ticket: TabKitchenTicket
      from: Stage
      to: Stage
    } | null>(null),
    [reason, setReason] = useState('')
  const [noticeConsent, setNoticeConsent] = useState(false)
  const alive = useRef(false),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    readingDetail = useRef(false),
    writing = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // Invalidate asynchronous reads; this ref is a numeric generation, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epoch.current++
      controller.current?.abort()
    }
  }, [])
  const mayAct =
    state.ready &&
    !state.pending &&
    !state.busy &&
    !props.disabled &&
    list.fresh &&
    !list.loading &&
    !detailLoading
  const manager = list.data?.actorRole === 'manager' || list.data?.actorRole === 'owner'
  async function loadDetail(ticketId: string, pending: boolean, afterSequence?: number) {
    if (readingDetail.current || writing.current) return
    readingDetail.current = true
    setDetailLoading(true)
    setDetailError('')
    setNoticeConsent(false)
    const generation = ++epoch.current,
      abort = new AbortController()
    controller.current = abort
    const query = new URLSearchParams({
      branchId: props.branchId,
      deviceId: props.deviceId,
      ticketId,
    })
    if (afterSequence !== undefined) query.set('afterSequence', String(afterSequence))
    try {
      const data = tabKitchenDetailSchema.parse(
        await tabKitchenCall(`/api/pos/tab-kitchen?${query}`, undefined, abort.signal)
      )
      if (data.branchId !== props.branchId || data.ticket.id !== ticketId) throw new Error('scope')
      if (alive.current && generation === epoch.current) setDetail({ data, pending })
    } catch {
      if (alive.current && generation === epoch.current)
        setDetailError(
          'Kitchen notices could not be checked. Refresh before acknowledging or changing preparation.'
        )
    } finally {
      if (generation === epoch.current) {
        readingDetail.current = false
        if (alive.current) setDetailLoading(false)
      }
    }
  }
  async function execute(command: TabKitchenCommand) {
    if (writing.current) return
    writing.current = true
    epoch.current++
    controller.current?.abort()
    readingDetail.current = false
    setDetailLoading(false)
    list.hold()
    setConfirm(null)
    setReason('')
    setNoticeConsent(false)
    try {
      await state.execute(command)
      if (alive.current) setDetail(null)
    } finally {
      writing.current = false
      if (alive.current) await list.resume()
    }
  }
  function move(ticket: TabKitchenTicket, from: Stage, to: Stage, reason: string | null = null) {
    if (!mayAct || ticket.pendingChangeCount) return
    void execute(
      tabKitchenCommandSchema.parse({
        id: browserUuid(),
        branchId: props.branchId,
        deviceId: props.deviceId,
        type: 'stage',
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        from,
        to,
        reason,
      })
    )
  }
  const tickets = list.data ? (history ? list.data.terminalTickets : list.data.activeTickets) : []
  const currentDetailTicket =
    detail &&
    [...(list.data?.activeTickets ?? []), ...(list.data?.terminalTickets ?? [])].find(
      (ticket) => ticket.id === detail.data.ticket.id
    )
  const detailFresh =
    !!detail &&
    !detailError &&
    !detailLoading &&
    currentDetailTicket?.revision === detail.data.ticket.revision
  const pendingEvents = detail?.pending ? detail.data.events : []
  const prefixComplete =
    !!detail &&
    pendingEvents.length > 0 &&
    pendingEvents[0].sequence === detail.data.ticket.acknowledgedSequence + 1 &&
    pendingEvents.every(
      (event, index) => event.sequence === detail.data.ticket.acknowledgedSequence + index + 1
    )
  return (
    <section className={styles.board} aria-label="Dispatched order kitchen">
      <header className={styles.heading}>
        <div>
          <h2>Sent orders at {props.branchName}</h2>
          <p>Saved orders sent to the kitchen. Payment and preparation are tracked separately.</p>
        </div>
        <button
          disabled={list.loading || state.busy || props.disabled}
          onClick={() => void list.load()}
        >
          Refresh sent orders
        </button>
      </header>
      <p className={styles.scope}>
        Review new orders, changes and stop notices before moving preparation. Added quantities do
        not repeat items already served.
      </p>
      <TabKitchenPendingPanel
        key={state.pending?.id ?? 'none'}
        state={state}
        disabled={props.disabled}
        run={(recover) => {
          if (!state.pending || writing.current) return
          writing.current = true
          list.hold()
          void state.execute(state.pending, recover, true).finally(async () => {
            writing.current = false
            setDetail(null)
            await list.resume()
          })
        }}
      />
      {list.error && (
        <p role="alert" className={styles.error}>
          {list.error}
        </p>
      )}
      {list.data && (
        <>
          <p className={styles.updated}>
            {list.fresh ? 'Last confirmed' : 'Last confirmed view — refresh needed'}{' '}
            {time(list.data.generatedAt)} Dubai time. Refreshes every 10 seconds while visible.
          </p>
          <nav className={styles.toolbar} aria-label="Sent kitchen views">
            <button
              aria-pressed={!history}
              onClick={() => {
                setHistory(false)
                setConfirm(null)
                setDetail(null)
              }}
            >
              Active ({list.data.activeCount})
            </button>
            <button
              aria-pressed={history}
              onClick={() => {
                setHistory(true)
                setConfirm(null)
                setDetail(null)
              }}
            >
              Completed history
            </button>
            <span>{list.data.pendingCount} orders need notice review across all pages</span>
          </nav>
          {history && (
            <p className={styles.help}>
              Completed preparation and acknowledged stop notices.{' '}
              {list.data.terminalTruncated && 'Only the latest 50 tickets are shown.'}
            </p>
          )}
          {!history && (list.cursor || list.data.activeNextCursor) && (
            <div className={styles.pagination}>
              <p>
                Showing {tickets.length} of {list.data.activeCount} active tickets. Counts include
                all pages.
              </p>
              <button
                disabled={!list.cursor || list.loading || state.busy}
                onClick={() => {
                  setDetail(null)
                  void list.load(null)
                }}
              >
                First page
              </button>
              <button
                disabled={!list.data.activeNextCursor || list.loading || state.busy}
                onClick={() => {
                  setDetail(null)
                  void list.load(list.data!.activeNextCursor)
                }}
              >
                Next page
              </button>
            </div>
          )}
        </>
      )}
      {!list.data && list.loading && <p role="status">Loading dispatched kitchen orders…</p>}
      {list.data && !tickets.length && (
        <p className={styles.empty}>
          {history
            ? 'No recent completed kitchen orders.'
            : list.cursor
              ? 'No orders remain on this page. Return to the first page.'
              : 'No sent orders need preparation or notice review.'}
        </p>
      )}
      {detailError && (
        <p role="alert" className={styles.error}>
          {detailError}
        </p>
      )}
      <div className={styles.orders}>
        {tickets.map((ticket) => {
          const selected =
            confirm?.ticket.id === ticket.id && confirm.ticket.revision === ticket.revision
          const ticketDetail = detail?.data.ticket.id === ticket.id ? detail : null
          return (
            <article
              className={styles.order}
              key={ticket.id}
              aria-label={`Kitchen order ${ticket.metadata.label}`}
            >
              <div className={styles.orderTop}>
                <div>
                  <h3>{ticket.metadata.label}</h3>
                  <p className={styles.reference}>
                    Kitchen {ticket.id.slice(0, 8)} · Sent order revision{' '}
                    {ticket.dispatchedTabRevision}
                  </p>
                </div>
                <PaymentBadge ticket={ticket} />
              </div>
              {ticket.invoiceNumber && (
                <p className={styles.reference}>Invoice {ticket.invoiceNumber}</p>
              )}
              <Metadata value={ticket.metadata} />
              <p className={styles.updated}>
                First sent {time(ticket.issuedAt)} Dubai time · Preparation round{' '}
                {ticket.generation}
              </p>
              {ticket.state === 'cancelled' && (
                <p className={styles.error}>
                  <strong>Preparation cancelled.</strong> Stop work and review the notice, including
                  quantities already prepared or served. No kitchen button refunds payment.
                </p>
              )}
              {ticket.pendingChangeCount > 0 && (
                <div className={styles.noticeCard}>
                  <strong>
                    {ticket.pendingChangeCount} kitchen{' '}
                    {ticket.pendingChangeCount === 1 ? 'notice needs' : 'notices need'} review
                  </strong>
                  <p>Preparation actions are paused until every pending notice is acknowledged.</p>
                  <button disabled={!mayAct} onClick={() => void loadDetail(ticket.id, true)}>
                    Review notices
                  </button>
                </div>
              )}
              {ticket.state === 'open' && (
                <div className={styles.stages}>
                  {stages.map((stage, index) => (
                    <section
                      className={styles.stage}
                      key={stage}
                      aria-label={`${stageLabels[stage]} quantities`}
                    >
                      <h4>{stageLabels[stage]}</h4>
                      {ticket.stages[stage].length ? (
                        <ul>
                          {ticket.stages[stage].map((line) => (
                            <li key={line.productId}>
                              <strong>{quantity(line)}</strong> {line.name}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={styles.help}>None</p>
                      )}
                      {ticket.stages[stage].length > 0 && (
                        <>
                          {index < 3 && (
                            <button
                              className={styles.primary}
                              disabled={!mayAct || ticket.pendingChangeCount > 0}
                              onClick={() => {
                                const to = stages[index + 1]
                                if (to === 'served') {
                                  setConfirm({ ticket, from: stage, to })
                                  setReason('')
                                } else move(ticket, stage, to)
                              }}
                            >
                              {stage === 'queued'
                                ? 'Start queued items'
                                : stage === 'preparing'
                                  ? 'Mark preparing items ready'
                                  : 'Mark ready items served'}
                            </button>
                          )}
                          {manager && index > 0 && (
                            <button
                              disabled={!mayAct || ticket.pendingChangeCount > 0}
                              onClick={() => {
                                setConfirm({ ticket, from: stage, to: stages[index - 1] })
                                setReason('')
                              }}
                            >
                              Correct {stageLabels[stage].toLowerCase()} items
                            </button>
                          )}
                        </>
                      )}
                    </section>
                  ))}
                </div>
              )}
              {selected && (
                <div className={styles.confirm}>
                  <p>
                    <strong>
                      {confirm.to === 'served'
                        ? 'Confirm all ready quantities shown have been handed over.'
                        : `Move every ${stageLabels[confirm.from].toLowerCase()} quantity back to ${stageLabels[confirm.to].toLowerCase()}?`}
                    </strong>
                  </p>
                  {confirm.to !== 'served' && (
                    <label>
                      Reason for preparation correction
                      <textarea
                        maxLength={240}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                  )}
                  <div className={styles.actions}>
                    <button
                      disabled={
                        !mayAct ||
                        ticket.pendingChangeCount > 0 ||
                        (confirm.to !== 'served' && !reason.trim())
                      }
                      onClick={() =>
                        move(
                          ticket,
                          confirm.from,
                          confirm.to,
                          confirm.to === 'served' ? null : reason.trim()
                        )
                      }
                    >
                      Confirm preparation change
                    </button>
                    <button onClick={() => setConfirm(null)}>Keep current preparation</button>
                  </div>
                </div>
              )}
              <button disabled={!mayAct} onClick={() => void loadDetail(ticket.id, false, 0)}>
                View dispatch history
              </button>
              {ticketDetail && (
                <section
                  aria-label={
                    ticketDetail.pending ? 'Pending kitchen notices' : 'Kitchen dispatch history'
                  }
                  className={styles.editor}
                >
                  <div className={styles.heading}>
                    <h4>{ticketDetail.pending ? 'Notices to acknowledge' : 'Dispatch history'}</h4>
                    <button
                      onClick={() => {
                        setDetail(null)
                        setNoticeConsent(false)
                      }}
                    >
                      Close notices
                    </button>
                  </div>
                  {!detailFresh && (
                    <p className={styles.error}>
                      This order changed or notices could not refresh. Review the latest notices
                      before acknowledging.
                    </p>
                  )}
                  {ticketDetail.data.events.map((event) => (
                    <article
                      className={styles.noticeCard}
                      key={event.sequence}
                      aria-label={`Kitchen notice ${event.sequence}`}
                    >
                      <h4>
                        {event.kind === 'void'
                          ? 'Stop: order voided'
                          : event.kind === 'refund'
                            ? 'Stop: payment refunded'
                            : event.kind === 'reopen'
                              ? 'Reopened order — new preparation'
                              : event.before
                                ? 'Order changed'
                                : 'New kitchen order'}
                      </h4>
                      <p className={styles.reference}>
                        Notice {event.sequence} · {time(event.createdAt)} Dubai time
                      </p>
                      {event.reason && (
                        <p>
                          <strong>Reason:</strong> {event.reason}
                        </p>
                      )}
                      <ChangeList changes={changesBetween(event.before, event.after)} />
                      {event.withdrawals.length > 0 && (
                        <>
                          <p>
                            <strong>Withdrawn quantities — check work already done:</strong>
                          </p>
                          <ul className={styles.changes}>
                            {event.withdrawals.map((line, index) => (
                              <li key={index}>
                                {quantity(line)} {line.name} from{' '}
                                {stageLabels[line.stage].toLowerCase()}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {event.additions.length > 0 && (
                        <>
                          <p>
                            <strong>New quantities queued:</strong>
                          </p>
                          <ul className={styles.changes}>
                            {event.additions.map((line) => (
                              <li key={line.productId}>
                                {quantity(line)} {line.name}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {!event.before && <Metadata value={event.after.metadata} />}
                      {(event.kind === 'void' || event.kind === 'refund') && (
                        <p>
                          Stop preparation. Check with the counter if food is already prepared or
                          served. Acknowledgement records that this notice was reviewed; it does not
                          undo food preparation.
                        </p>
                      )}
                    </article>
                  ))}
                  {ticketDetail.data.events.length === 0 && <p>No notices on this page.</p>}
                  {ticketDetail.pending ? (
                    <>
                      <p className={styles.help}>
                        {ticketDetail.data.events.length} of{' '}
                        {ticketDetail.data.ticket.pendingChangeCount} pending notices shown.{' '}
                        {ticketDetail.data.eventsNextAfter !== null &&
                          'Acknowledge this page, then review the remaining notices.'}
                      </p>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={noticeConsent}
                          disabled={!mayAct || !detailFresh || !prefixComplete}
                          onChange={(event) => setNoticeConsent(event.target.checked)}
                        />
                        I have reviewed every notice shown, including stopped or changed quantities.
                      </label>
                      <button
                        className={styles.primary}
                        disabled={!mayAct || !detailFresh || !prefixComplete || !noticeConsent}
                        onClick={() => {
                          const last = ticketDetail.data.events.at(-1)
                          if (last)
                            void execute(
                              tabKitchenCommandSchema.parse({
                                id: browserUuid(),
                                branchId: props.branchId,
                                deviceId: props.deviceId,
                                type: 'acknowledge',
                                ticketId: ticket.id,
                                expectedRevision: ticketDetail.data.ticket.revision,
                                throughSequence: last.sequence,
                              })
                            )
                        }}
                      >
                        Acknowledge {ticketDetail.data.events.length} shown notices
                      </button>
                    </>
                  ) : (
                    ticketDetail.data.eventsNextAfter !== null && (
                      <button
                        disabled={!mayAct}
                        onClick={() =>
                          void loadDetail(ticket.id, false, ticketDetail.data.eventsNextAfter!)
                        }
                      >
                        Next history page
                      </button>
                    )
                  )}
                </section>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
