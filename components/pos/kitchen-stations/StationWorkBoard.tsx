'use client'

import { browserUuid } from '@/lib/pos/browser-uuid'
import { useEffect, useRef, useState } from 'react'
import {
  stationWorkListSchema,
  stationWorkDetailSchema,
  stationWorkRecoverySchema,
  stationWorkResultMatches,
  stationWorkCommandSchema,
  stationWorkListMatchesQuery,
  stationWorkDetailMatchesQuery,
  type StationWork,
  type StationWorkList,
  type StationWorkDetail,
  type StationWorkCommand,
  type StationWorkNotice,
} from '@/lib/pos/server/kitchen-station-work'
import {
  readPendingStationWorkRequests,
  savePendingStationWorkRequest,
  acknowledgeStationWorkRequest,
  stationWorkJournalEvent,
  type PendingStationWorkRequest,
} from '@/lib/pos/kitchen-station-work-journal'
import styles from './station-work.module.css'
type Props = {
  actorId: string
  branchId: string
  deviceId: string
  role: 'owner' | 'manager' | 'cashier'
  disabled: boolean
  recoveryOnly?: boolean
  onBlockedChange?: (blocked: boolean) => void
}
type Stage = 'queued' | 'preparing' | 'ready' | 'served'
const stages: Stage[] = ['queued', 'preparing', 'ready', 'served']
const labels: Record<Stage, string> = {
  queued: 'Waiting',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
}
function quantity(line: { quantityMilli: number; unit: string }) {
  const unit = line.quantityMilli === 1000 || line.unit === 'kg' ? line.unit : `${line.unit}s`
  return `${new Intl.NumberFormat('en-AE', { maximumFractionDigits: 3 }).format(line.quantityMilli / 1000)} ${unit}`
}
async function request(url: string, actorId: string, command?: StationWorkCommand) {
  const response = await fetch(url, {
    method: command ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'x-pos-actor': actorId, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    body: command ? JSON.stringify(command) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error('unconfirmed')
  return response.json() as Promise<unknown>
}
export function StationWorkPendingRecovery(
  props: Omit<Props, 'role' | 'deviceId'> & { role?: Props['role']; deviceId?: string }
) {
  return (
    <StationWorkBoard
      {...props}
      role={props.role ?? 'cashier'}
      deviceId={props.deviceId ?? ''}
      recoveryOnly
    />
  )
}
export default function StationWorkBoard(props: Props) {
  return (
    <Board
      key={`${props.actorId}:${props.branchId}:${props.deviceId}:${!!props.recoveryOnly}`}
      {...props}
    />
  )
}
function Board({
  actorId,
  branchId,
  deviceId,
  role,
  disabled,
  onBlockedChange,
  recoveryOnly = false,
}: Props) {
  const [filter, setFilter] = useState('all'),
    [view, setView] = useState<'active' | 'history'>('active'),
    [list, setList] = useState<StationWorkList | null>(null),
    [detail, setDetail] = useState<StationWorkDetail | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [noticeView, setNoticeView] = useState<'pending' | 'all'>('pending'),
    [pending, setPending] = useState<PendingStationWorkRequest[]>([]),
    [storage, setStorage] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [reason, setReason] = useState('')
  const alive = useRef(false),
    epoch = useRef(0),
    journalEpoch = useRef(0),
    action = useRef(false),
    loading = useRef(false),
    current = useRef({ disabled, filter, view, selected, noticeView, reason, role }),
    notify = useRef(onBlockedChange)
  current.current = { disabled, filter, view, selected, noticeView, reason, role }
  notify.current = onBlockedChange
  const blocked = busy || pending.length > 0 || !storage || reason.length > 0
  function invalidate() {
    epoch.current++
  }
  useEffect(() => {
    notify.current?.(blocked)
    if (!blocked) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [blocked])
  async function journal() {
    const version = ++journalEpoch.current
    try {
      const rows = await readPendingStationWorkRequests(actorId)
      if (alive.current && version === journalEpoch.current) {
        setPending(recoveryOnly ? rows.filter((row) => row.command.branchId === branchId) : rows)
        setStorage(true)
      }
      return rows
    } catch (error) {
      if (alive.current && version === journalEpoch.current) setStorage(false)
      throw error
    }
  }
  async function refresh() {
    if (
      recoveryOnly ||
      action.current ||
      loading.current ||
      current.current.disabled ||
      current.current.reason
    )
      return
    loading.current = true
    const version = ++epoch.current
    const scope = { ...current.current }
    setBusy(true)
    setError('')
    setList(null)
    setDetail(null)
    const valid = () => alive.current && version === epoch.current && !current.current.disabled
    try {
      await journal()
      if (!valid()) return
      let first: StationWorkList | null = null,
        cursor: { at: string; id: string } | null = null
      const items: StationWork[] = []
      do {
        const query = new URLSearchParams({
          branchId,
          deviceId,
          station: scope.filter,
          view: scope.view,
          ...(cursor ? { cursorAt: cursor.at, cursorId: cursor.id } : {}),
        })
        const page = stationWorkListSchema.parse(
          await request(`/api/pos/kitchen-station-work?${query}`, actorId)
        )
        if (!valid()) return
        if (
          !stationWorkListMatchesQuery(
            {
              branchId,
              deviceId,
              station: scope.filter,
              view: scope.view,
              ...(cursor ? { cursorAt: cursor.at, cursorId: cursor.id } : {}),
            },
            page
          )
        )
          throw new Error('list_query')
        if (
          page.branchId !== branchId ||
          page.items.some(
            (work) =>
              work.branchId !== branchId ||
              (scope.filter !== 'all' && (work.stationId ?? 'general') !== scope.filter)
          )
        )
          throw new Error('scope')
        if (
          first &&
          (page.organizationId !== first.organizationId ||
            page.actorRole !== first.actorRole ||
            page.matchingCount !== first.matchingCount ||
            page.attentionCount !== first.attentionCount ||
            JSON.stringify(page.stations) !== JSON.stringify(first.stations))
        )
          throw new Error('changed')
        items.push(...page.items)
        first ??= page
        if (items.length > 100000 || items.length > first.matchingCount) throw new Error('bound')
        const next = page.nextCursor
        if (
          next &&
          (!page.items.length ||
            next.id !== page.items.at(-1)?.id ||
            next.at !==
              (scope.view === 'active'
                ? page.items.at(-1)?.issuedAt
                : page.items.at(-1)?.updatedAt))
        )
          throw new Error('cursor')
        cursor = next
      } while (cursor)
      if (!first || items.length !== first.matchingCount) throw new Error('incomplete')
      let nextDetail: StationWorkDetail | null = null
      if (scope.selected) {
        let after = 0,
          initial: StationWorkDetail | null = null
        const notices: StationWorkNotice[] = []
        do {
          const query = new URLSearchParams({
            branchId,
            deviceId,
            workId: scope.selected,
            noticeView: scope.noticeView,
            afterSequence: String(after),
          })
          const page = stationWorkDetailSchema.parse(
            await request(`/api/pos/kitchen-station-work/detail?${query}`, actorId)
          )
          if (!valid()) return
          if (
            !stationWorkDetailMatchesQuery(
              {
                branchId,
                deviceId,
                workId: scope.selected,
                noticeView: scope.noticeView,
                afterSequence: after,
              },
              page
            )
          )
            throw new Error('detail_query')
          if (
            page.branchId !== branchId ||
            page.work.id !== scope.selected ||
            page.work.branchId !== branchId ||
            page.organizationId !== first.organizationId ||
            page.actorRole !== first.actorRole
          )
            throw new Error('scope')
          if (
            initial &&
            (JSON.stringify(page.work) !== JSON.stringify(initial.work) ||
              page.noticeCount !== initial.noticeCount)
          )
            throw new Error('changed')
          for (const notice of page.notices) {
            if (
              notice.workId !== scope.selected ||
              notice.sequence <= after ||
              (notices.length && notice.sequence <= notices.at(-1)!.sequence) ||
              (scope.noticeView === 'pending' && notice.acknowledgedAt !== null)
            )
              throw new Error('notice_scope')
            notices.push(notice)
          }
          initial ??= page
          if (notices.length > 100000 || notices.length > initial.noticeCount)
            throw new Error('bound')
          if (
            page.nextAfterSequence !== null &&
            (page.nextAfterSequence <= after ||
              page.nextAfterSequence !== page.notices.at(-1)?.sequence)
          )
            throw new Error('cursor')
          after = page.nextAfterSequence ?? 0
        } while (after)
        if (!initial || notices.length !== initial.noticeCount) throw new Error('incomplete')
        nextDetail = { ...initial, notices, nextAfterSequence: null }
      }
      if (valid()) {
        setList({ ...first, items, nextCursor: null })
        setDetail(nextDetail)
      }
    } catch {
      if (valid())
        setError(
          'Kitchen work could not be verified. Refresh for a complete current view. Saved actions remain available.'
        )
    } finally {
      loading.current = false
      if (alive.current) {
        setBusy(false)
        if (version !== epoch.current && !current.current.disabled) void refresh()
      }
    }
  }
  useEffect(() => {
    alive.current = true
    const read = () => {
      void journal().catch(() => {
        if (alive.current)
          setError('Saved kitchen actions could not be read. Keep browser data intact.')
      })
    }
    read()
    window.addEventListener(stationWorkJournalEvent, read)
    window.addEventListener('focus', read)
    let channel: BroadcastChannel | undefined
    try {
      channel = new BroadcastChannel(stationWorkJournalEvent)
      channel.onmessage = read
    } catch {}
    return () => {
      alive.current = false
      invalidate()
      window.removeEventListener(stationWorkJournalEvent, read)
      window.removeEventListener('focus', read)
      channel?.close()
      notify.current?.(false)
    }
    // This component owns one immutable actor/branch/device scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    invalidate()
    setList(null)
    setDetail(null)
    if (disabled || recoveryOnly) {
      if (!action.current) setBusy(false)
      return
    }
    void refresh()
    // Changing filters invalidates older paginated reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, filter, view, selected, noticeView, role, recoveryOnly])
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const timer = setInterval(poll, 10000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
    // Poll uses current refs; dirty forms and active actions suppress refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function execute(command: StationWorkCommand, saved = false) {
    if (
      action.current ||
      current.current.disabled ||
      command.branchId !== branchId ||
      (!saved && (!detail || pending.length || !storage || busy))
    )
      return
    action.current = true
    const version = ++epoch.current
    setBusy(true)
    setError('')
    setMessage('')
    let durable = saved,
      confirmed = false
    const valid = () => alive.current && epoch.current === version && !current.current.disabled
    try {
      const parsed = stationWorkCommandSchema.parse(command)
      if (!saved) {
        await savePendingStationWorkRequest({ actorId, command: parsed })
        durable = true
        await journal()
      }
      if (!valid()) return
      const result = stationWorkRecoverySchema.parse(
        await request(
          saved ? '/api/pos/kitchen-station-work/recovery' : '/api/pos/kitchen-station-work',
          actorId,
          parsed
        )
      )
      if (!stationWorkResultMatches(parsed, result) || (!saved && result.status !== 'updated'))
        throw new Error('ack')
      if (!valid()) return
      await acknowledgeStationWorkRequest(actorId, parsed, result)
      if (!valid()) return
      await journal()
      if (!valid()) return
      setReason('')
      current.current.reason = ''
      confirmed = true
      setMessage(
        result.status === 'cancelled'
          ? 'The saved action was cancelled. Review current work before another action.'
          : 'Kitchen action confirmed.'
      )
      setDetail(null)
    } catch {
      if (valid()) {
        if (!durable) setStorage(false)
        setError(
          durable
            ? 'This action is not confirmed. Check its saved request before another action. Checking finds the original result or cancels an action that was never applied.'
            : 'The action was not sent. Restore browser storage before continuing.'
        )
      }
    } finally {
      action.current = false
      if (alive.current) {
        setBusy(false)
        if (!current.current.disabled && (confirmed || version !== epoch.current)) void refresh()
      }
    }
  }
  const work = detail?.work,
    paused = disabled || busy || !!pending.length || !storage || !detail
  const canReverse =
    (role === 'owner' || role === 'manager') &&
    (detail?.actorRole === 'owner' || detail?.actorRole === 'manager')
  const command = (
    fields:
      | { type: 'stage'; from: Stage; to: Stage; reason: string | null }
      | { type: 'notice.ack'; noticeId: string }
  ) => {
    if (work)
      void execute({
        id: browserUuid(),
        branchId,
        deviceId,
        workId: work.id,
        expectedRevision: work.revision,
        ...fields,
      })
  }
  const recoveryPanel = (
    <>
      {' '}
      {pending.map((row) => (
        <div className={styles.attention} key={row.command.id}>
          <h3>Check a saved kitchen action</h3>
          <p>
            {row.command.type === 'stage' ? 'Preparation stage change' : 'Notice acknowledgement'}.
            Checking retrieves its result or cancels it if never applied.
          </p>
          {row.command.branchId !== branchId && (
            <p>
              Return to the original branch to check this action. Its saved scope will not change.
            </p>
          )}
          <button
            type="button"
            disabled={disabled || busy || !storage || row.command.branchId !== branchId}
            onClick={() => void execute(row.command, true)}
          >
            Check saved action
          </button>
        </div>
      ))}
    </>
  )
  if (recoveryOnly)
    return pending.length || !storage ? (
      <section className={styles.board} aria-label="Saved kitchen station actions">
        {error && <p role="alert">{error}</p>}
        {recoveryPanel}
        {!storage && <p>Saved actions could not yet be verified. Keep browser data intact.</p>}
      </section>
    ) : null
  return (
    <section className={styles.board} aria-label="Kitchen station work">
      <header className={styles.heading}>
        <div>
          <h2>Kitchen by station</h2>
          <p>Each action changes only the selected station’s work.</p>
        </div>
        <button
          type="button"
          disabled={disabled || busy || !!reason}
          onClick={() => void refresh()}
        >
          Refresh work
        </button>
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {recoveryPanel}
      <div className={styles.filters}>
        <label>
          Station
          <select
            value={filter}
            disabled={disabled || busy || !!reason}
            onChange={(event) => {
              setFilter(event.target.value)
              setSelected(null)
            }}
          >
            <option value="all">All stations</option>
            <option value="general">General</option>
            {list?.stations
              .filter((s) => s.stationId !== null)
              .map((s) => (
                <option key={s.stationId!} value={s.stationId!}>
                  {s.name}
                  {s.active ? '' : ' (archived)'}
                </option>
              ))}
          </select>
        </label>
        <label>
          Show
          <select
            value={view}
            disabled={disabled || busy || !!reason}
            onChange={(event) => {
              setView(event.target.value as 'active' | 'history')
              setSelected(null)
            }}
          >
            <option value="active">Active work and notices</option>
            <option value="history">Completed history</option>
          </select>
        </label>
      </div>
      {list ? (
        <p className={list.attentionCount ? styles.attention : styles.summary}>
          {list.attentionCount} {list.attentionCount === 1 ? 'work item needs' : 'work items need'}{' '}
          notice review across the branch. General:{' '}
          {list.stations.find((s) => s.stationId === null)?.activeCount ?? 0} active{' '}
          {(list.stations.find((s) => s.stationId === null)?.activeCount ?? 0) === 1
            ? 'item'
            : 'items'}
          . {filter !== 'all' && 'Other stations remain visible under All stations.'}
        </p>
      ) : (
        <p role="status">
          {busy
            ? 'Loading complete station work…'
            : 'Station work unavailable. Refresh to try again.'}
        </p>
      )}
      <div className={styles.layout}>
        <div className={styles.cards}>
          {list?.items.length === 0 && (
            <p>
              No {view === 'active' ? 'active work or notices' : 'completed work'} in this view.
            </p>
          )}
          {list?.items.map((item) => (
            <button
              type="button"
              className={styles.card}
              aria-label={`${item.stationName} ${item.invoiceNumber ?? item.metadata.label ?? 'Unpaid order'} ${item.pendingNoticeCount} notices`}
              key={item.id}
              aria-pressed={selected === item.id}
              disabled={disabled || busy || !!reason}
              onClick={() => setSelected(item.id)}
            >
              <strong>{item.stationName}</strong>
              <span>{item.invoiceNumber ?? item.metadata.label ?? 'Unpaid order'}</span>
              <span>
                {item.metadata.tableName ?? item.metadata.serviceType} · {item.payment}
                {item.state === 'cancelled' ? ' · cancelled' : ''}
              </span>
              <span>
                {stages
                  .filter((stage) => item.stages[stage].length)
                  .map(
                    (stage) =>
                      `${labels[stage]}: ${item.stages[stage].length} ${item.stages[stage].length === 1 ? 'product' : 'products'}`
                  )
                  .join(' · ') || 'No preparation quantities'}
              </span>
              {item.pendingNoticeCount > 0 && (
                <strong>
                  {item.pendingNoticeCount} {item.pendingNoticeCount === 1 ? 'notice' : 'notices'}{' '}
                  to check
                </strong>
              )}
            </button>
          ))}
        </div>
        <div className={styles.detail}>
          {work ? (
            <>
              <h3>{work.stationName} preparation</h3>
              {work.pendingNoticeCount > 0 && (
                <p>
                  <a href={`#station-notices-${work.id}`}>
                    Review {work.pendingNoticeCount}{' '}
                    {work.pendingNoticeCount === 1 ? 'notice' : 'notices'} before changing
                    preparation
                  </a>
                </p>
              )}
              <p>
                {work.invoiceNumber ?? work.metadata.label ?? 'Unpaid order'}
                {work.metadata.tableName ? ` · ${work.metadata.tableName}` : ''}
              </p>
              {work.metadata.note && <p className={styles.note}>{work.metadata.note}</p>}
              {work.state === 'cancelled' && (
                <p>Preparation cancelled. Check any remaining notices.</p>
              )}
              {stages.map((stage, index) => (
                <section className={styles.stage} key={stage}>
                  <h4>{labels[stage]}</h4>
                  {work.stages[stage].length ? (
                    <ul>
                      {work.stages[stage].map((line) => (
                        <li key={JSON.stringify([line.productId, line.name, line.unit])}>
                          <span>{line.name}</span>
                          <strong>{quantity(line)}</strong>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>None</p>
                  )}
                  {work.stages[stage].length > 0 && work.state === 'open' && (
                    <div className={styles.actions}>
                      {index < 3 && (
                        <button
                          type="button"
                          disabled={paused || work.pendingNoticeCount > 0}
                          onClick={() =>
                            command({
                              type: 'stage',
                              from: stage,
                              to: stages[index + 1],
                              reason: null,
                            })
                          }
                        >
                          {index === 0
                            ? 'Start preparing'
                            : index === 1
                              ? 'Mark ready'
                              : 'Mark served'}{' '}
                          — all {labels[stage].toLowerCase()} items
                        </button>
                      )}
                      {index > 0 && canReverse && (
                        <button
                          type="button"
                          className={styles.secondary}
                          disabled={paused || work.pendingNoticeCount > 0 || !reason.trim()}
                          onClick={() =>
                            command({
                              type: 'stage',
                              from: stage,
                              to: stages[index - 1],
                              reason: reason.trim(),
                            })
                          }
                        >
                          Return to {labels[stages[index - 1]].toLowerCase()}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              ))}
              {canReverse && (
                <label>
                  Reason for moving work back
                  <input
                    maxLength={240}
                    value={reason}
                    disabled={paused}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  {reason && (
                    <button type="button" disabled={busy || disabled} onClick={() => setReason('')}>
                      Discard reason
                    </button>
                  )}
                </label>
              )}
              <h3 id={`station-notices-${work.id}`}>Changes to check</h3>
              {work.pendingNoticeCount > 0 && (
                <p className={styles.attention}>
                  Check and acknowledge this station’s notices before changing its preparation
                  stage. Check cooking and stock separately; acknowledgement does not adjust them.
                </p>
              )}
              <label>
                Notices
                <select
                  value={noticeView}
                  disabled={disabled || busy || !!reason}
                  onChange={(event) => setNoticeView(event.target.value as 'pending' | 'all')}
                >
                  <option value="pending">Awaiting acknowledgement</option>
                  <option value="all">All notices</option>
                </select>
              </label>
              {detail.notices.length === 0 && <p>No notices in this view.</p>}
              {detail.notices.map((notice) => (
                <article className={styles.notice} key={notice.id}>
                  <h4>
                    {notice.kind === 'cancel'
                      ? 'Preparation cancelled — order fully returned'
                      : notice.kind === 'return'
                        ? 'Returned items'
                        : notice.kind === 'void'
                          ? 'Preparation withdrawn'
                          : notice.kind === 'reopen'
                            ? 'Order reopened'
                            : 'Order updated'}
                  </h4>
                  <time dateTime={notice.createdAt}>
                    {new Date(notice.createdAt).toLocaleString('en-AE')}
                  </time>
                  {notice.reason && <p>{notice.reason}</p>}
                  <NoticeLines notice={notice} />
                  {notice.acknowledgedAt ? (
                    <p>Acknowledged {new Date(notice.acknowledgedAt).toLocaleString('en-AE')}</p>
                  ) : (
                    <button
                      type="button"
                      disabled={paused || !!reason}
                      onClick={() => command({ type: 'notice.ack', noticeId: notice.id })}
                    >
                      Acknowledge this notice
                    </button>
                  )}
                </article>
              ))}
            </>
          ) : (
            <p>Select work to see its quantities and notices.</p>
          )}
        </div>
      </div>
    </section>
  )
}
function NoticeLines({ notice }: { notice: StationWorkNotice }) {
  if (notice.kind === 'cancel')
    return (
      <>
        <p>
          {notice.source.creditNumber}. These quantities describe stopped preparation, not
          quantities returned on this credit.
        </p>
        <ul>
          {notice.detail.lines.map((line) => (
            <li key={JSON.stringify([line.productId, line.name, line.unit])}>
              {line.name}: {quantity(line)} stopped.
            </li>
          ))}
        </ul>
      </>
    )
  if (notice.kind === 'return')
    return (
      <>
        <p>
          {notice.source.creditNumber} ·{' '}
          {notice.source.fullyReturned ? 'Full return' : 'Partial return'}
        </p>
        <ul>
          {notice.detail.lines.map((line) => (
            <li key={line.originalLineNumber}>
              {line.name}: {quantity(line)} returned;{' '}
              {quantity({ ...line, quantityMilli: line.remainingQuantityMilli })} remains on the
              invoice.
            </li>
          ))}
        </ul>
      </>
    )
  return (
    <>
      {notice.detail.metadataBefore && (
        <p>
          Previous details: {notice.detail.metadataBefore.label ?? 'Unlabelled'} ·{' '}
          {notice.detail.metadataBefore.tableName ?? notice.detail.metadataBefore.serviceType}
          {notice.detail.metadataBefore.guestCount
            ? ` · ${notice.detail.metadataBefore.guestCount} guests`
            : ''}
          {notice.detail.metadataBefore.note ? ` · ${notice.detail.metadataBefore.note}` : ''}
        </p>
      )}
      <p>
        Order details: {notice.detail.metadataAfter.label ?? 'Unlabelled'} ·{' '}
        {notice.detail.metadataAfter.tableName ?? notice.detail.metadataAfter.serviceType}
        {notice.detail.metadataAfter.guestCount
          ? ` · ${notice.detail.metadataAfter.guestCount} guests`
          : ''}
        {notice.detail.metadataAfter.note ? ` · ${notice.detail.metadataAfter.note}` : ''}
      </p>
      {notice.detail.additions.length > 0 && (
        <>
          <h5>Added</h5>
          <ul>
            {notice.detail.additions.map((line) => (
              <li key={JSON.stringify([line.productId, line.name, line.unit])}>
                {line.name}: {quantity(line)}
              </li>
            ))}
          </ul>
        </>
      )}
      {notice.detail.withdrawals.length > 0 && (
        <>
          <h5>Withdrawn</h5>
          <ul>
            {notice.detail.withdrawals.map((line, index) => (
              <li key={`${line.productId}:${line.stage}:${index}`}>
                {line.name}: {quantity(line)} from {labels[line.stage]}
              </li>
            ))}
          </ul>
        </>
      )}
      {!notice.detail.additions.length && !notice.detail.withdrawals.length && (
        <p>No quantity changes. Check the updated order details.</p>
      )}
    </>
  )
}
