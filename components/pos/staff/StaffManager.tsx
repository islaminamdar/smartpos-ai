'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import {
  staffListSchema,
  staffUpdateSchema,
  staffUpdateResultSchema,
  staffInviteCommandSchema,
  staffInviteResultSchema,
  staffRevokeCommandSchema,
  staffRevokeResultSchema,
  type StaffList,
} from '@/lib/pos/server/staff'
import { formatFils } from '@/lib/pos/money'
import styles from './staff.module.css'
import StaffAccessHelp from './StaffAccessHelp'
const pendingSchema = z.discriminatedUnion('endpoint', [
  z.object({ endpoint: z.literal('/api/pos/staff'), body: staffUpdateSchema }),
  z.object({ endpoint: z.literal('/api/pos/staff/invitations'), body: staffInviteCommandSchema }),
  z.object({
    endpoint: z.literal('/api/pos/staff/invitations/revoke'),
    body: staffRevokeCommandSchema,
  }),
])
type Pending = z.infer<typeof pendingSchema>
type Member = StaffList['staff'][number]
class AccessError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code)
  }
}
async function call(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  })
  const data: unknown = await response.json()
  if (!response.ok)
    throw new AccessError(
      response.status,
      data && typeof data === 'object' && 'code' in data ? String(data.code) : 'unavailable'
    )
  return data
}
export default function StaffManager(props: {
  actorId: string
  branchId: string
  deviceId: string
  disabled: boolean
  onChanged?: () => Promise<void>
}) {
  return <Manager key={`${props.actorId}:${props.branchId}:${props.deviceId}`} {...props} />
}
function Manager({
  actorId,
  branchId,
  deviceId,
  disabled,
  onChanged,
}: {
  actorId: string
  branchId: string
  deviceId: string
  disabled: boolean
  onChanged?: () => Promise<void>
}) {
  const [data, setData] = useState<StaffList | null>(null),
    [member, setMember] = useState<Member | null>(null),
    [invite, setInvite] = useState(false),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all')
  const [pending, setPending] = useState<Pending | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [link, setLink] = useState<{ url: string; email: string; expiresAt: string } | null>(null),
    [copied, setCopied] = useState(false),
    [allowCancellation, setAllowCancellation] = useState(false)
  const mounted = useRef(false),
    locked = useRef(false),
    key = `pos-staff-request:${actorId}:${branchId}`
  async function load() {
    const result = staffListSchema.parse(
      await call(`/api/pos/staff?branchId=${encodeURIComponent(branchId)}`)
    )
    if (result.branchId !== branchId) throw new Error('scope')
    if (mounted.current) setData(result)
    return result
  }
  useEffect(() => {
    mounted.current = true
    try {
      const raw = sessionStorage.getItem(key)
      if (raw) {
        const saved = pendingSchema.parse(JSON.parse(raw))
        if (saved.body.branchId !== branchId) throw new Error('scope')
        setPending(saved)
      }
      setReady(true)
    } catch {
      setError(
        'The saved staff change could not be read. Editing is paused; ask your administrator for help before clearing browser data.'
      )
    }
    void load().catch(() => {
      if (mounted.current)
        setError(
          'Staff access could not be loaded. Reload to try again; no empty staff list is assumed.'
        )
    })
    return () => {
      mounted.current = false
    }
    // This keyed component owns one branch/device for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])
  async function execute(command: Pending, resolve = false) {
    if (disabled || locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    setNotice('')
    setLink(null)
    setCopied(false)
    let written = false,
      confirmed = false
    try {
      sessionStorage.setItem(key, JSON.stringify(command))
      written = true
      setPending(command)
      const raw = resolve
        ? await call('/api/pos/staff/recovery', {
            endpoint: command.endpoint,
            request: command.body,
          })
        : await call(command.endpoint, command.body)
      const kind =
        command.endpoint === '/api/pos/staff'
          ? 'staff.update'
          : command.endpoint.endsWith('/revoke')
            ? 'invitation.revoke'
            : 'invitation.create'
      const cancelled =
        resolve &&
        z
          .object({
            status: z.literal('cancelled'),
            requestId: z.literal(command.body.id),
            kind: z.literal(kind),
            replayed: z.boolean(),
          })
          .strict()
          .safeParse(raw).success
      if (cancelled) {
        // The server tombstone prevents a delayed copy of the original write.
      } else if (command.endpoint === '/api/pos/staff') {
        const result = staffUpdateResultSchema.parse(raw)
        if (
          result.requestId !== command.body.id ||
          result.staff.userId !== command.body.targetUserId ||
          result.staff.revision !== command.body.expectedRevision + 1 ||
          result.staff.active !== command.body.active ||
          result.staff.role !== command.body.role ||
          result.staff.branchId !== command.body.assignedBranchId ||
          result.staff.displayName !== command.body.displayName
        )
          throw new Error('ack_mismatch')
      } else if (command.endpoint === '/api/pos/staff/invitations') {
        const result = staffInviteResultSchema.parse(raw)
        if (
          result.requestId !== command.body.id ||
          result.invitation.id !== command.body.id ||
          result.invitation.email !== command.body.email ||
          result.invitation.displayName !== command.body.displayName ||
          new Date(result.invitation.expiresAt).getTime() !==
            new Date(command.body.expiresAt).getTime() ||
          result.invitation.branchId !== command.body.assignedBranchId ||
          result.invitation.role !== command.body.role
        )
          throw new Error('ack_mismatch')
        const url = new URL(result.setupUrl)
        if (
          url.origin !== window.location.origin ||
          url.pathname !== '/staff/accept' ||
          url.search ||
          !/^#token=[a-f0-9]{64}$/.test(url.hash)
        )
          throw new Error('link_mismatch')
        if (mounted.current)
          setLink({
            url: url.toString(),
            email: result.invitation.email,
            expiresAt: result.invitation.expiresAt,
          })
      } else {
        const result = staffRevokeResultSchema.parse(raw)
        if (
          result.requestId !== command.body.id ||
          result.invitationId !== command.body.invitationId
        )
          throw new Error('ack_mismatch')
      }
      confirmed = true
      sessionStorage.removeItem(key)
      if (!mounted.current) return
      setPending(null)
      setAllowCancellation(false)
      setMember(null)
      setInvite(false)
      setNotice(
        cancelled
          ? 'The server confirmed this staff change was not saved and permanently cancelled it. Review current access before making another change.'
          : command.endpoint === '/api/pos/staff/invitations'
            ? 'Invitation created — not sent.'
            : command.endpoint.endsWith('/revoke')
              ? 'Invitation revoked. Its link can no longer be accepted.'
              : 'Staff access saved. Existing sales and receipts stay unchanged.'
      )
      await load()
      await onChanged?.()
    } catch (cause) {
      if (!mounted.current) return
      if (!written) {
        setReady(false)
        setError(
          'Browser storage is unavailable. No change was sent. Restore storage before editing access.'
        )
      } else if (confirmed)
        setError(
          'The change was saved, but the screen could not refresh. Reload to see the latest access.'
        )
      else if (
        cause instanceof AccessError &&
        ((cause.status === 409 && cause.code === 'staff_conflict') ||
          (cause.status === 422 && cause.code === 'invalid_staff_request'))
      ) {
        // These exact server responses cannot later commit this frozen request.
        // Clear storage before releasing the editing lock; refresh before editing.
        try {
          sessionStorage.removeItem(key)
          setPending(null)
          setMember(null)
          setInvite(false)
          setData(null)
          await load()
          setError(
            'The change was not saved. The latest staff access is now shown; select the person and make a new change.'
          )
        } catch {
          setReady(false)
          setError(
            'The rejected change could not be cleared or the latest access could not load. Editing is paused. Reload before trying again; do not clear browser data.'
          )
        }
      } else if (cause instanceof AccessError && cause.code === 'staff_open_shifts')
        setError(
          'This person has open shifts. Ask them to close their shifts, then retry this same saved change. No drawer was closed or transferred.'
        )
      else if (cause instanceof AccessError && cause.status === 401)
        setError('Sign in again on this counter, then retry the saved staff change.')
      else if (cause instanceof AccessError && cause.status === 403)
        setError(
          'This change requires an authorised manager or owner on the original counter. Restore access before retrying.'
        )
      else
        setError(
          'The staff change could not be confirmed. Retry the saved change with the same request number; editing remains paused until it is resolved.'
        )
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const paused = disabled || busy || !!pending || !ready || !data
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (paused) return
    try {
      const values = new FormData(event.currentTarget),
        role = String(values.get('role') ?? 'cashier'),
        scope = String(values.get('scope') ?? branchId),
        common = {
          id: crypto.randomUUID(),
          branchId,
          deviceId,
          reason: String(values.get('reason') ?? ''),
        }
      if (invite)
        void execute(
          pendingSchema.parse({
            endpoint: '/api/pos/staff/invitations',
            body: {
              ...common,
              email: String(values.get('email') ?? ''),
              displayName: String(values.get('displayName') ?? ''),
              role,
              assignedBranchId: scope === 'organization' ? null : scope,
              expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            },
          })
        )
      else if (member && member.role !== 'owner')
        void execute(
          pendingSchema.parse({
            endpoint: '/api/pos/staff',
            body: {
              ...common,
              targetUserId: member.userId,
              expectedRevision: member.revision,
              displayName: String(values.get('displayName') ?? '').trim() || null,
              active: values.get('active') === 'on',
              role,
              assignedBranchId: scope === 'organization' ? null : scope,
            },
          })
        )
    } catch {
      setError(
        'Check the name, email, role, branch and reason before saving. Cashiers need a branch.'
      )
    }
  }
  return (
    <section className={styles.staff} aria-label="Staff access">
      <div className={styles.heading}>
        <div>
          <h2>Staff access</h2>
          <p>
            {data?.actorRole === 'owner'
              ? 'Manage cashier and manager access. Owner accounts are read-only here.'
              : 'Manage cashiers for this branch. Manager and owner access cannot be changed here.'}
          </p>
        </div>
        <button
          className={styles.primary}
          disabled={paused || !data?.capabilities.inviteLinks}
          onClick={() => {
            setInvite(true)
            setMember(null)
            setError('')
            setLink(null)
          }}
        >
          Invite staff member
        </button>
      </div>
      <p className={styles.help}>
        {data?.capabilities.accountSetup
          ? 'Share the invitation privately. New cashiers can verify their own email and choose a password; existing accounts sign in. No email is sent by this screen.'
          : 'Invitation links work for existing accounts with verified email addresses. New account verification and email recovery are not configured yet. No email is sent by this screen.'}
      </p>
      <StaffAccessHelp accountSetup={data?.capabilities.accountSetup} />
      {data && !data.capabilities.inviteLinks && (
        <p className={styles.pending}>
          Invitation links are not enabled yet. Existing staff access can still be reviewed.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {pending && (
        <div className={styles.pending}>
          <strong>A staff change needs confirmation</strong>
          <p>Keep this tab available. Retry sends the same saved request.</p>
          <button disabled={disabled || busy || !ready} onClick={() => void execute(pending)}>
            {busy ? 'Checking saved change…' : 'Retry saved staff change'}
          </button>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={allowCancellation}
              disabled={disabled || busy || !ready}
              onChange={(event) => setAllowCancellation(event.target.checked)}
            />
            If this change was not saved, permanently cancel it.
          </label>
          <button
            disabled={disabled || busy || !ready || !allowCancellation}
            onClick={() => void execute(pending, true)}
          >
            Check saved change
          </button>
          {pending.body.deviceId !== deviceId && (
            <p>
              This change belongs to your earlier enrolled counter. Use Check saved change to
              reconcile its original request.
            </p>
          )}
        </div>
      )}
      {link && (
        <section className={styles.linkPanel} aria-label="Private invitation link">
          <h3>Give this link privately to {link.email}</h3>
          <p>
            Expires {new Date(link.expiresAt).toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })}{' '}
            Dubai time. The recipient must sign in with their own verified account.
          </p>
          <label>
            Private invitation link
            <textarea readOnly value={link.url} />
          </label>
          <button
            onClick={() =>
              void (async () => {
                try {
                  if (!navigator.clipboard) throw new Error('clipboard_unavailable')
                  await navigator.clipboard.writeText(link.url)
                  setCopied(true)
                } catch {
                  setError('The link could not be copied. Select and copy it from the field above.')
                }
              })()
            }
          >
            {copied ? 'Link copied' : 'Copy invitation link'}
          </button>
          <p className={styles.help}>
            Copying does not send or deliver this invitation. The link is shown only in this result
            panel.
          </p>
        </section>
      )}
      {!data ? (
        <p role="status">Staff information is unavailable until the branch request completes.</p>
      ) : (
        <div className={styles.layout}>
          <aside className={styles.list} aria-label="Staff list">
            <label>
              Find staff
              <input value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <label>
              Show
              <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="all">All staff</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
            {!data.staff.length && <p>No staff memberships are listed for this branch.</p>}
            {data.staff
              .filter(
                (person) =>
                  (filter === 'all' || person.active === (filter === 'active')) &&
                  `${person.email} ${person.displayName ?? ''}`
                    .toLowerCase()
                    .includes(search.toLowerCase())
              )
              .map((person) => (
                <button
                  key={person.userId}
                  disabled={paused}
                  aria-pressed={member?.userId === person.userId}
                  onClick={() => {
                    setMember(person)
                    setInvite(false)
                    setError('')
                    setLink(null)
                  }}
                >
                  <strong>{person.displayName || person.email}</strong>
                  <small>{person.email}</small>
                  <span className={styles.badge}>
                    {person.role} · {person.active ? 'Active' : 'Inactive'}
                    {person.openShifts.length ? ' · Shift open' : ''}
                  </span>
                </button>
              ))}
          </aside>
          <div>
            {(invite || member) && (
              <form
                onSubmit={submit}
                key={invite ? 'invite' : `${member?.userId}:${member?.revision}`}
              >
                <fieldset disabled={paused || member?.role === 'owner'}>
                  <legend>{invite ? 'Invite a staff member' : 'Review staff access'}</legend>
                  {member?.role === 'owner' ? (
                    <p className={styles.readonly}>
                      Owner access is read-only. Ownership changes are not available here.
                    </p>
                  ) : null}
                  <label>
                    Name for this branch
                    <input
                      name="displayName"
                      maxLength={120}
                      required={invite}
                      defaultValue={member?.displayName ?? ''}
                    />
                  </label>
                  {invite ? (
                    <label>
                      Email
                      <input
                        name="email"
                        type="email"
                        autoComplete="off"
                        required
                        maxLength={254}
                      />
                    </label>
                  ) : (
                    <p className={styles.secret}>{member?.email}</p>
                  )}
                  <RoleFields
                    owner={data.actorRole === 'owner'}
                    role={member?.role === 'manager' ? 'manager' : 'cashier'}
                    assignedBranchId={member ? member.branchId : branchId}
                    branchId={branchId}
                  />
                  {!invite && (
                    <label className={styles.check}>
                      <input name="active" type="checkbox" defaultChecked={member?.active} />
                      Active access
                    </label>
                  )}
                  {!!member?.openShifts.length && (
                    <div className={styles.pending}>
                      <strong>
                        Open shifts must be closed before role, branch or active access changes.
                      </strong>
                      {member.openShifts.map((shift) => (
                        <p key={shift.id}>
                          {shift.deviceName} · expected cash AED{' '}
                          {formatFils(shift.expectedCashFils)}
                        </p>
                      ))}
                      <p>Name-only corrections are allowed.</p>
                    </div>
                  )}
                  <label>
                    Reason for this change
                    <textarea name="reason" required maxLength={240} rows={2} />
                  </label>
                  <p className={styles.help}>
                    {invite
                      ? 'The private link expires in seven days. It does not activate a new account or reset a password.'
                      : 'Deactivating branch access preserves receipts and staff identity. It does not delete the account or change its password.'}
                  </p>
                  {member?.role !== 'owner' && (
                    <button className={styles.primary}>
                      {busy ? 'Saving…' : invite ? 'Create invitation' : 'Save staff access'}
                    </button>
                  )}
                </fieldset>
              </form>
            )}
            {!invite && !member && (
              <p>
                Select a staff member to review access, or create an invitation. No password is
                visible to managers.
              </p>
            )}
            <h3>Invitations</h3>
            {!data.invitations.length && <p>No invitations are listed.</p>}
            {data.invitations.map((invitation) => (
              <details key={invitation.id}>
                <summary className={styles.secret}>
                  {invitation.displayName} ·{' '}
                  {invitation.status === 'pending' ? 'Awaiting acceptance' : invitation.status}
                </summary>
                <p className={styles.secret}>
                  {invitation.email} · {invitation.role}
                </p>
                <p className={styles.help}>
                  Expires{' '}
                  {new Date(invitation.expiresAt).toLocaleString('en-AE', {
                    timeZone: 'Asia/Dubai',
                  })}{' '}
                  Dubai time.
                </p>
                {invitation.status === 'pending' && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (paused) return
                      const values = new FormData(event.currentTarget)
                      try {
                        void execute(
                          pendingSchema.parse({
                            endpoint: '/api/pos/staff/invitations/revoke',
                            body: {
                              id: crypto.randomUUID(),
                              branchId,
                              deviceId,
                              invitationId: invitation.id,
                              reason: String(values.get('reason') ?? ''),
                            },
                          })
                        )
                      } catch {
                        setError('Enter a reason before revoking this invitation.')
                      }
                    }}
                  >
                    <label>
                      Reason to revoke this invitation
                      <input name="reason" required maxLength={240} disabled={paused} />
                    </label>
                    <button disabled={paused}>Revoke invitation</button>
                    <p className={styles.help}>
                      Revoking stops this invitation link. It does not reset or delete an account.
                      Create a new invitation after revocation if a replacement is needed.
                    </p>
                  </form>
                )}
              </details>
            ))}
            {data.invitationHistoryTruncated && (
              <p className={styles.help}>
                All pending invitations are shown. Older completed invitation history is omitted
                from this screen.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
function RoleFields({
  owner,
  role,
  assignedBranchId,
  branchId,
}: {
  owner: boolean
  role: 'manager' | 'cashier'
  assignedBranchId: string | null
  branchId: string
}) {
  const [value, setValue] = useState(role),
    [scope, setScope] = useState(assignedBranchId ?? 'organization')
  return owner ? (
    <div className={styles.fields}>
      <label>
        Role
        <select
          name="role"
          value={value}
          onChange={(event) => {
            setValue(event.target.value as typeof value)
            if (event.target.value === 'cashier' && scope === 'organization') setScope(branchId)
          }}
        >
          <option value="cashier">Cashier</option>
          <option value="manager">Manager</option>
        </select>
      </label>
      <label>
        Branch access
        <select name="scope" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value={branchId}>This branch</option>
          {assignedBranchId && assignedBranchId !== branchId && (
            <option value={assignedBranchId}>Keep assigned branch</option>
          )}
          {value === 'manager' && (
            <option value="organization">All branches in this business</option>
          )}
        </select>
      </label>
    </div>
  ) : (
    <>
      <p>Role: Cashier · this branch only</p>
      <input type="hidden" name="role" value="cashier" />
      <input type="hidden" name="scope" value={branchId} />
    </>
  )
}
