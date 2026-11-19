/**
 * Request and response body schemas for the OpenAPI document (#152), keyed by the same `Controller.method` operationId
 * that `buildOpenApi` emits. Request schemas mirror the zod schemas the handlers parse with (openapi.spec.ts checks the
 * auth ones field by field); response schemas describe what the handlers return. Kept as plain JSON Schema so the
 * committed docs/openapi.json is exactly what this module says, and the generated frontend client is typed.
 *
 * Covered: the auth, pools and catalog endpoints the frontend calls most. Others still document routes, auth and
 * params only; add an entry here (and run `pnpm openapi`) to describe more.
 */
export type JsonSchema = Record<string, unknown>;

export const API_SCHEMAS: Record<string, JsonSchema> = {
  OtpRequest: {
    type: 'object',
    properties: { phone: { type: 'string' } },
    required: ['phone'],
  },
  OtpRequestResponse: {
    type: 'object',
    properties: { phone: { type: 'string' }, devCode: { type: 'string', description: 'Development only' } },
    required: ['phone'],
  },
  OtpVerify: {
    type: 'object',
    properties: { phone: { type: 'string' }, code: { type: 'string', pattern: '^\\d{6}$' } },
    required: ['phone', 'code'],
  },
  RefreshRequest: {
    type: 'object',
    properties: { refreshToken: { type: 'string', minLength: 10 } },
    required: ['refreshToken'],
  },
  TokenPair: {
    type: 'object',
    properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, expiresIn: { type: 'integer' } },
    required: ['accessToken', 'refreshToken', 'expiresIn'],
  },
  AuthSession: {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        properties: { id: { type: 'string' }, phone: { type: 'string' }, walletAddress: { type: ['string', 'null'] } },
        required: ['id', 'phone', 'walletAddress'],
      },
      roles: { type: 'array', items: { type: 'string' } },
      accessToken: { type: 'string' },
      refreshToken: { type: 'string' },
      expiresIn: { type: 'integer' },
    },
    required: ['user', 'roles', 'accessToken', 'refreshToken', 'expiresIn'],
  },
  PoolCard: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      state: { type: 'string' },
      organizer: { type: 'string' },
      supplier: { type: ['string', 'null'] },
      shareSlug: { type: ['string', 'null'] },
      offerId: { type: ['string', 'null'] },
      totalUnits: { type: 'integer' },
      moq: { type: 'integer' },
      progressPct: { type: 'integer', minimum: 0, maximum: 100 },
      fillDeadline: { type: 'string', format: 'date-time' },
      title: { type: ['string', 'null'] },
      unitLabel: { type: ['string', 'null'] },
      currentUnitPriceNaira: { type: ['string', 'null'] },
      hub: { type: 'string' },
    },
    required: ['id', 'state', 'totalUnits', 'moq', 'progressPct'],
  },
  PoolQuote: {
    type: 'object',
    properties: {
      units: { type: 'integer' },
      amountNowUsdc: { type: 'string', description: 'Stroop-precision integer as a string' },
      amountNowDisplay: { type: 'string' },
      amountNowNairaEstimate: { type: ['string', 'null'] },
      currentUnitPriceUsdc: { type: 'string' },
      expectedRefundIfClosedNowUsdc: { type: 'string' },
      nextBreak: {
        type: ['object', 'null'],
        properties: { unitsToGo: { type: 'integer' }, unitPriceUsdc: { type: 'string' } },
      },
      note: { type: 'string' },
    },
    required: ['units', 'amountNowUsdc', 'amountNowDisplay', 'currentUnitPriceUsdc', 'expectedRefundIfClosedNowUsdc', 'nextBreak', 'note'],
  },
  FxQuote: {
    type: 'object',
    properties: { ngnPerUsd: { type: 'number' }, sources: { type: 'integer' }, at: { type: 'string', format: 'date-time' }, ttlSeconds: { type: 'integer' } },
    required: ['ngnPerUsd', 'sources', 'at', 'ttlSeconds'],
  },
  PublicOffer: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      supplierId: { type: 'string' },
      title: { type: 'string' },
      brand: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      unitLabel: { type: 'string' },
      category: { type: 'string' },
      perishable: { type: 'boolean' },
      images: { type: 'array', items: { type: 'string' } },
      tiersNgn: {},
      tiersUsdc: {},
      moq: { type: 'integer' },
      maxUnits: { type: ['integer', 'null'] },
      maxPerMember: { type: ['integer', 'null'] },
      leadTimeHours: { type: 'integer' },
      deliveryAreas: {
        type: 'array',
        items: { type: 'object', properties: { state: { type: 'string' }, lga: { type: 'string' } }, required: ['state'] },
      },
      validUntil: { type: 'string', format: 'date-time' },
      offerHash: { type: ['string', 'null'] },
      status: { type: 'string' },
    },
    required: ['id', 'supplierId', 'title', 'unitLabel', 'category', 'moq', 'validUntil', 'status'],
  },
};

export const OPERATION_BODIES: Record<string, { request?: JsonSchema; response?: JsonSchema }> = {
  'AuthController.request': { request: { $ref: '#/components/schemas/OtpRequest' }, response: { $ref: '#/components/schemas/OtpRequestResponse' } },
  'AuthController.verify': { request: { $ref: '#/components/schemas/OtpVerify' }, response: { $ref: '#/components/schemas/AuthSession' } },
  'AuthController.refresh': { request: { $ref: '#/components/schemas/RefreshRequest' }, response: { $ref: '#/components/schemas/TokenPair' } },
  'AuthController.logout': { request: { $ref: '#/components/schemas/RefreshRequest' } },
  'PoolsController.list': { response: { type: 'array', items: { $ref: '#/components/schemas/PoolCard' } } },
  'PoolsController.quote': { response: { $ref: '#/components/schemas/PoolQuote' } },
  'CatalogController.fxQuote': { response: { $ref: '#/components/schemas/FxQuote' } },
  'CatalogController.list': { response: { type: 'array', items: { $ref: '#/components/schemas/PublicOffer' } } },
  'CatalogController.one': { response: { $ref: '#/components/schemas/PublicOffer' } },
};
