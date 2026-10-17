import { z } from 'zod'
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const email = z.string().trim().toLowerCase().email().max(254)
const displayName = z.string().trim().min(1).max(120)
const revision = z.number().int().min(1).max(2_147_483_647)
const timestamp = z.string().datetime({ offset: true })
const reason = z.string().trim().min(1).max(240)
const command = { id: uuid, branchId: uuid, deviceId: uuid, reason }
export const staffMemberSchema = z
  .object({
    userId: uuid,
    email,
    displayName: displayName.nullable(),
    role: z.enum(['owner', 'manager', 'cashier']),
    branchId: uuid.nullable(),
    active: z.boolean(),
    revision,
  })
  .strict()
export const staffInvitationSchema = z
  .object({
    id: uuid,
    email,
    displayName,
    role: z.enum(['manager', 'cashier']),
    branchId: uuid.nullable(),
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    expiresAt: timestamp,
    createdAt: timestamp,
  })
  .strict()
export const staffListSchema = z
  .object({
    status: z.literal('ready'),
    organizationId: uuid,
    branchId: uuid,
    actorRole: z.enum(['owner', 'manager']),
    staff: z
      .array(
        staffMemberSchema
          .extend({
            openShifts: z
              .array(
                z
                  .object({
                    id: uuid,
                    deviceId: uuid,
                    deviceName: z.string().min(1).max(80),
                    openedAt: timestamp,
                    expectedCashFils: z.number().int().min(-100_000_000_000).max(100_000_000_000),
                  })
                  .strict()
              )
              .max(500),
          })
          .strict()
      )
      .max(500),
    invitations: z.array(staffInvitationSchema).max(200),
    invitationHistoryTruncated: z.boolean(),
    capabilities: z
      .object({
        inviteLinks: z.boolean(),
        emailDelivery: z.boolean(),
        accountSetup: z.boolean().default(false),
      })
      .strict(),
  })
  .strict()
export const staffUpdateSchema = z
  .object({
    ...command,
    targetUserId: uuid,
    expectedRevision: revision,
    displayName: displayName.nullable(),
    active: z.boolean(),
    role: z.enum(['cashier', 'manager']),
    assignedBranchId: uuid.nullable(),
  })
  .strict()
  .refine((value) => value.role !== 'cashier' || value.assignedBranchId !== null, {
    message: 'Cashiers require a branch.',
  })
export const staffUpdateResultSchema = z
  .object({
    status: z.literal('updated'),
    requestId: uuid,
    replayed: z.boolean(),
    staff: staffMemberSchema,
  })
  .strict()
export const staffInviteCommandSchema = z
  .object({
    ...command,
    email,
    displayName,
    role: z.enum(['cashier', 'manager']),
    assignedBranchId: uuid.nullable(),
    expiresAt: timestamp,
  })
  .strict()
  .refine((value) => value.role !== 'cashier' || value.assignedBranchId !== null, {
    message: 'Cashiers require a branch.',
  })
export const staffInviteResultSchema = z
  .object({
    status: z.literal('invited'),
    requestId: uuid,
    replayed: z.boolean(),
    invitation: staffInvitationSchema,
    setupUrl: z.string().url(),
  })
  .strict()
export const staffRevokeCommandSchema = z.object({ ...command, invitationId: uuid }).strict()
export const staffRevokeResultSchema = z
  .object({
    status: z.literal('revoked'),
    requestId: uuid,
    replayed: z.boolean(),
    invitationId: uuid,
  })
  .strict()
export const staffAcceptSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    email,
    password: z.string().min(1).max(256),
  })
  .strict()
export const staffAcceptResultSchema = z
  .object({
    status: z.literal('accepted'),
    invitationId: uuid,
    branchId: uuid.nullable(),
    role: z.enum(['manager', 'cashier']),
    replayed: z.boolean(),
  })
  .strict()
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z
      .string()
      .min(12)
      .max(72)
      .refine((value) => new TextEncoder().encode(value).length <= 72, {
        message: 'Use at most 72 UTF-8 bytes.',
      }),
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'Choose a different password.',
  })
export type StaffList = z.infer<typeof staffListSchema>
export type StaffMember = z.infer<typeof staffMemberSchema>
export type StaffInvitation = z.infer<typeof staffInvitationSchema>
export type StaffUpdate = z.infer<typeof staffUpdateSchema>
export type StaffInviteCommand = z.infer<typeof staffInviteCommandSchema>
export type StaffRevokeCommand = z.infer<typeof staffRevokeCommandSchema>
