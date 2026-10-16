import { z } from 'zod'
import { PayPalError, type PayPalConfig } from './config'
import {
  validatePlan,
  validateSubscription,
  approvalUrl,
  transactionSchema,
  cents,
  providerId,
} from './contracts'
export class PayPalProvider {
  private token: string | null = null
  constructor(readonly config: PayPalConfig) {}
  private async request(
    path: string,
    method = 'GET',
    body?: unknown,
    requestId?: string,
    rawBody?: string
  ): Promise<unknown> {
    if (!this.token) {
      let response: Response
      try {
        response = await fetch(this.config.base + '/v1/oauth2/token', {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(this.config.clientId + ':' + this.config.secret).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
        })
      } catch {
        throw new PayPalError('paypal_unavailable')
      }
      if (!response.ok) throw new PayPalError('paypal_authentication_unavailable')
      const data = (await response.json()) as { access_token?: unknown }
      if (typeof data.access_token !== 'string')
        throw new PayPalError('paypal_authentication_unavailable')
      this.token = data.access_token
    }
    let response: Response
    try {
      response = await fetch(this.config.base + path, {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
        },
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      })
    } catch {
      throw new PayPalError('paypal_response_unconfirmed')
    }
    if (!response.ok) throw new PayPalError('paypal_response_unconfirmed')
    if (response.status === 204) return null
    try {
      return await response.json()
    } catch {
      throw new PayPalError('paypal_response_unconfirmed')
    }
  }
  async checkPlan(planId = this.config.planId) {
    if (!/^P-[A-Z0-9]{24}$/.test(planId)) throw new PayPalError('paypal_plan_mismatch')
    validatePlan(await this.request('/v1/billing/plans/' + planId), planId)
  }
  async create(checkoutId: string, branchId: string) {
    await this.checkPlan()
    const result = await this.request(
      '/v1/billing/subscriptions',
      'POST',
      {
        plan_id: this.config.planId,
        custom_id: checkoutId,
        application_context: {
          brand_name: 'Internext POS',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
          return_url: `${this.config.origin}/billing?branchId=${branchId}&approval=returned`,
          cancel_url: `${this.config.origin}/billing?branchId=${branchId}&approval=cancelled`,
        },
      },
      checkoutId
    )
    // Creation responses may be minimal; all commercial identity comes from canonical GET.
    const created = z.object({ id: providerId }).parse(result)
    return this.get(created.id, checkoutId)
  }
  async get(id: string, checkoutId: string, identityPlan?: string) {
    providerId.parse(id)
    return validateSubscription(
      await this.request(`/v1/billing/subscriptions/${id}?fields=plan,last_failed_payment`),
      { ...this.config, planId: identityPlan ?? this.config.planId },
      checkoutId,
      id,
      Boolean(identityPlan)
    )
  }
  approval(subscription: Awaited<ReturnType<PayPalProvider['get']>>) {
    const link = subscription.links?.find((link) => link.rel === 'approve')
    return link ? approvalUrl(link.href, this.config.environment) : null
  }
  async cancel(id: string) {
    providerId.parse(id)
    await this.request(`/v1/billing/subscriptions/${id}/cancel`, 'POST', {
      reason: 'Branch administrator requested cancellation through Internext POS.',
    })
  }
  async transactions(id: string, start: string, end: string) {
    providerId.parse(id)
    const parsed = z
      .object({
        transactions: z.array(z.unknown()).max(1000),
        total_items: z.number().int().nonnegative().optional(),
        total_pages: z.number().int().nonnegative().optional(),
        links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
      })
      .safeParse(
        await this.request(
          `/v1/billing/subscriptions/${id}/transactions?${new URLSearchParams({ start_time: start, end_time: end })}`
        )
      )
    if (!parsed.success) throw new PayPalError('paypal_transactions_unconfirmed')
    const data = parsed.data
    // A checkpoint may advance only for a complete time window. Do not follow
    // provider-supplied URLs or silently accept an explicitly partial response.
    if (
      (data.total_items !== undefined && data.total_items !== data.transactions.length) ||
      (data.total_pages !== undefined &&
        (data.total_pages > 1 || (data.total_pages === 0 && data.transactions.length > 0))) ||
      data.links?.some((link) => link.rel.toLowerCase() === 'next')
    )
      throw new PayPalError('paypal_transactions_unconfirmed')
    return data.transactions.map((raw) => {
      const tx = transactionSchema.parse(raw)
      return {
        id: tx.id,
        status: tx.status,
        time: tx.time,
        amountCents: cents(tx.amount_with_breakdown.gross_amount.value),
        currency: 'USD',
      }
    })
  }
  async saleReference(id: string) {
    if (!/^[A-Z0-9-]{5,64}$/.test(id)) throw new PayPalError('paypal_sale_unconfirmed')
    return z
      .object({
        id: z.literal(id),
        billing_agreement_id: providerId,
        create_time: z.string().datetime({ offset: true }),
      })
      .parse(await this.request('/v1/payments/sale/' + id))
  }
  async verifyWebhook(raw: string, headers: Headers) {
    const fields: Record<string, string> = {}
    for (const [field, header] of Object.entries({
      transmission_id: 'paypal-transmission-id',
      transmission_time: 'paypal-transmission-time',
      transmission_sig: 'paypal-transmission-sig',
      cert_url: 'paypal-cert-url',
      auth_algo: 'paypal-auth-algo',
    })) {
      const value = headers.get(header)
      if (!value || value.length > 8000) throw new PayPalError('invalid_webhook_signature', 401)
      fields[field] = value
    }
    // Never fetch a caller-supplied certificate URL. PayPal performs cryptographic verification.
    // Embed the original event bytes rather than parsing/re-serializing signed JSON.
    JSON.parse(raw)
    const prefix = JSON.stringify({ ...fields, webhook_id: this.config.webhookId }).slice(0, -1)
    const result = (await this.request(
      '/v1/notifications/verify-webhook-signature',
      'POST',
      undefined,
      undefined,
      prefix + ',"webhook_event":' + raw + '}'
    )) as { verification_status?: unknown }
    if (result.verification_status !== 'SUCCESS')
      throw new PayPalError('invalid_webhook_signature', 401)
  }
}
