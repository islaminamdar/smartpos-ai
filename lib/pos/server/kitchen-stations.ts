import { z } from 'zod'

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const revision = z.number().int().min(0).max(2147483647)
const name = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      [...value].length <= 60 &&
      value === value.trim() &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value.toLowerCase() !== 'general'
  )
const stationFields = { id: uuid, name, active: z.boolean() }
export const stationSchema = z
  .object({
    ...stationFields,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt))
const commandFields = {
  id: uuid,
  branchId: uuid,
  deviceId: uuid,
  expectedRevision: z.number().int().min(0).max(2147483646),
}
export const stationCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...commandFields,
      type: z.literal('station.save'),
      station: z.object(stationFields).strict(),
    })
    .strict(),
  z
    .object({
      ...commandFields,
      type: z.literal('route.set'),
      productId: uuid,
      stationId: uuid.nullable(),
    })
    .strict(),
])
export type StationCommand = z.infer<typeof stationCommandSchema>
const route = z.object({ productId: uuid, stationId: uuid }).strict()
const resultRoute = route.extend({ stationId: uuid.nullable() })
export const stationResultSchema = z
  .object({
    status: z.literal('applied'),
    requestId: uuid,
    branchId: uuid,
    replayed: z.boolean(),
    revision: revision.refine((value) => value > 0),
    station: stationSchema.nullable(),
    route: resultRoute.nullable(),
  })
  .strict()
  .refine((value) => (value.station === null) !== (value.route === null))
export const stationCancellationSchema = z
  .object({
    status: z.literal('cancelled'),
    requestId: uuid,
    branchId: uuid,
    replayed: z.boolean(),
  })
  .strict()
export const stationRecoverySchema = z.union([stationResultSchema, stationCancellationSchema])
export const stationQuerySchema = z
  .object({ branchId: uuid, deviceId: uuid, afterProductId: uuid.optional() })
  .strict()
const ordered = (ids: string[]) => ids.every((id, index) => index === 0 || ids[index - 1] < id)
export const stationListSchema = z
  .object({
    status: z.literal('ready'),
    organizationId: uuid,
    branchId: uuid,
    actorRole: z.enum(['owner', 'manager', 'cashier']),
    revision,
    generatedAt: z.string().datetime({ offset: true }),
    stations: z.array(stationSchema).max(128),
    routes: z.array(route).max(100),
    routeCount: z.number().int().min(0).max(2147483647),
    nextProductId: uuid.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const active = new Set(
      value.stations.filter((station) => station.active).map((station) => station.id)
    )
    if (
      !ordered(value.stations.map((station) => station.id)) ||
      !ordered(value.routes.map((item) => item.productId)) ||
      value.routes.some((item) => !active.has(item.stationId)) ||
      (value.routeCount > 0 && active.size === 0) ||
      value.routes.length > value.routeCount ||
      (value.nextProductId !== null &&
        (value.routes.length !== 100 ||
          value.nextProductId !== value.routes.at(-1)?.productId ||
          value.routeCount <= value.routes.length)) ||
      (value.revision === 0 && (value.stations.length !== 0 || value.routeCount !== 0))
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent station snapshot' })
  })
export function stationResultMatches(
  command: StationCommand,
  result: z.infer<typeof stationRecoverySchema>
) {
  if (result.requestId !== command.id || result.branchId !== command.branchId) return false
  if (result.status === 'cancelled') return true
  if (result.revision !== command.expectedRevision + 1) return false
  return command.type === 'station.save'
    ? result.route === null &&
        result.station !== null &&
        result.station.id === command.station.id &&
        result.station.name === command.station.name &&
        result.station.active === command.station.active
    : result.station === null &&
        result.route !== null &&
        result.route.productId === command.productId &&
        result.route.stationId === command.stationId
}
export function stationListMatchesQuery(
  query: z.infer<typeof stationQuerySchema>,
  result: z.infer<typeof stationListSchema>
) {
  if (result.branchId !== query.branchId) return false
  if (query.afterProductId)
    return result.routes.every((item) => item.productId > query.afterProductId!)
  return (
    result.routes.length === Math.min(result.routeCount, 100) &&
    (result.nextProductId !== null) === result.routeCount > 100
  )
}
