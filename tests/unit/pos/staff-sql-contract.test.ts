import { expect, it } from 'vitest'
import fixtures from '../../fixtures/pos-staff-output.json'
import {
  staffListSchema,
  staffUpdateResultSchema,
  staffInviteResultSchema,
  staffAcceptResultSchema,
  staffRevokeResultSchema,
} from '@/lib/pos/server/staff'
it('accepts the actual isolated PostgreSQL staff RPC outputs at the strict HTTP boundary', () => {
  expect(
    staffListSchema.safeParse({
      ...fixtures.list,
      capabilities: { inviteLinks: true, emailDelivery: false },
    }).success
  ).toBe(true)
  expect(staffUpdateResultSchema.safeParse(fixtures.updated).success).toBe(true)
  expect(
    staffInviteResultSchema.safeParse({
      ...fixtures.invited,
      setupUrl: 'https://pos.example/staff/accept#token=' + 'b'.repeat(64),
    }).success
  ).toBe(true)
  expect(staffAcceptResultSchema.safeParse(fixtures.accepted).success).toBe(true)
  expect(staffRevokeResultSchema.safeParse(fixtures.revoked).success).toBe(true)
})
