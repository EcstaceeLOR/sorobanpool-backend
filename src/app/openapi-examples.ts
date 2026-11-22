/**
 * Request and response examples for the most used endpoints (#178), keyed by OpenAPI operationId. buildOpenApi
 * attaches them to the document; openapi.spec.ts checks every request example against the handler's own zod schema
 * and every operationId against the routes, so an example cannot drift from the API without a failing test.
 * Values are illustrative: the addresses are the all-zero Stellar account and every id, hash and XDR is a placeholder.
 */
export interface OperationExample {
  request?: unknown;
  response: unknown;
}

export const OPENAPI_EXAMPLES: Record<string, OperationExample> = {
  'AuthController.request': {
    request: {
      phone: "08031234567"
    },
    response: {
      phone: "+2348031234567"
    }
  },
  'AuthController.verify': {
    request: {
      phone: "08031234567",
      code: "123456"
    },
    response: {
      user: {
        id: "cm3usr0000example",
        phone: "+2348031234567",
        walletAddress: null
      },
      roles: [
        "TRADER"
      ],
      accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example.signature",
      refreshToken: "Qm9vdHN0cmFwUmVmcmVzaFRva2VuRXhhbXBsZTAw",
      expiresIn: 900
    }
  },
  'AuthController.refresh': {
    request: {
      refreshToken: "Qm9vdHN0cmFwUmVmcmVzaFRva2VuRXhhbXBsZTAw"
    },
    response: {
      accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example.signature",
      refreshToken: "TmV4dFJlZnJlc2hUb2tlbkV4YW1wbGUwMDAwMDA",
      expiresIn: 900
    }
  },
  'CatalogController.fxQuote': {
    response: {
      ngnPerUsd: 1348.525,
      sources: 2,
      at: "2026-11-08T12:00:00.000Z",
      ttlSeconds: 60
    }
  },
  'CatalogController.list': {
    response: [
      {
        id: "cm3off0000example",
        supplierId: "cm3usr0001example",
        title: "Mama Gold Rice 50kg",
        brand: "Tunde Foods",
        description: "Long grain parboiled rice, 50kg bag.",
        unitLabel: "bag",
        category: "grains",
        perishable: false,
        images: [
          "cm3img0000example"
        ],
        tiersNgn: [
          {
            minUnits: 50,
            priceNgn: 45000
          },
          {
            minUnits: 100,
            priceNgn: 43500
          }
        ],
        tiersUsdc: [
          {
            minUnits: 50,
            unitPrice: "333700000"
          },
          {
            minUnits: 100,
            unitPrice: "322600000"
          }
        ],
        moq: 50,
        maxUnits: 200,
        maxPerMember: 20,
        leadTimeHours: 72,
        deliveryAreas: [
          {
            state: "Lagos",
            lga: "Lagos Island"
          }
        ],
        validUntil: "2026-12-31T23:00:00.000Z",
        offerHash: "6f1c9a2b7d3e4f5a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a",
        status: "LIVE"
      }
    ]
  },
  'CatalogController.one': {
    response: {
      id: "cm3off0000example",
      supplierId: "cm3usr0001example",
      title: "Mama Gold Rice 50kg",
      brand: "Tunde Foods",
      description: "Long grain parboiled rice, 50kg bag.",
      unitLabel: "bag",
      category: "grains",
      perishable: false,
      images: [
        "cm3img0000example"
      ],
      tiersNgn: [
        {
          minUnits: 50,
          priceNgn: 45000
        },
        {
          minUnits: 100,
          priceNgn: 43500
        }
      ],
      tiersUsdc: [
        {
          minUnits: 50,
          unitPrice: "333700000"
        },
        {
          minUnits: 100,
          unitPrice: "322600000"
        }
      ],
      moq: 50,
      maxUnits: 200,
      maxPerMember: 20,
      leadTimeHours: 72,
      deliveryAreas: [
        {
          state: "Lagos",
          lga: "Lagos Island"
        }
      ],
      validUntil: "2026-12-31T23:00:00.000Z",
      offerHash: "6f1c9a2b7d3e4f5a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a",
      status: "LIVE"
    }
  },
  'PoolsController.list': {
    response: [
      {
        id: "42",
        state: "Open",
        organizer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        supplier: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        shareSlug: "a1b2c3d4e5",
        offerId: "cm3off0000example",
        totalUnits: 30,
        moq: 50,
        progressPct: 60,
        fillDeadline: "2026-11-30T17:00:00.000Z",
        title: "Mama Gold Rice 50kg",
        unitLabel: "bag",
        currentUnitPriceNaira: "45,000",
        hub: "12 Balogun Market, Lagos Island",
        members: 4,
        category: "food",
        deliveryState: "Lagos",
        deliveryLga: "Lagos Island",
        cluster: null
      }
    ]
  },
  'PoolsController.get': {
    response: {
      id: "42",
      state: "Open",
      shareSlug: "a1b2c3d4e5",
      offerId: "cm3off0000example",
      organizer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      supplier: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      hub: {
        address: "12 Balogun Market, Lagos Island",
        contact: "+2348031234567"
      },
      pickupWindow: {
        from: "2026-12-05T08:00:00.000Z",
        to: "2026-12-05T16:00:00.000Z"
      },
      fillDeadline: "2026-11-30T17:00:00.000Z",
      totalUnits: 30,
      receivedUnits: 0,
      moq: 50,
      maxUnits: 200,
      members: 4,
      ngnPerUsd: 1348.525,
      filledAt: null,
      progressPct: 60,
      currentUnitPriceUsdc: "333700000",
      currentUnitPriceNaira: "45,000",
      nextBreak: {
        minUnits: 100,
        unitsToGo: 70,
        unitPriceUsdc: "322600000"
      },
      tiersUsdc: [
        {
          minUnits: 50,
          unitPrice: "333700000"
        },
        {
          minUnits: 100,
          unitPrice: "322600000"
        }
      ],
      finalUnitPriceUsdc: null,
      escrowBalanceUsdc: "10011000000",
      offer: null,
      trustMessage: "Your money is held safely. The supplier is paid only after the goods arrive. If the group does not fill, you get everything back automatically.",
      myCommitment: {
        units: 5,
        paid: "1668.5",
        pickedUp: false
      }
    }
  },
  'PoolsController.quote': {
    response: {
      units: 5,
      amountNowUsdc: "1668500000",
      amountNowDisplay: "166.85",
      amountNowNairaEstimate: "225,001",
      currentUnitPriceUsdc: "333700000",
      expectedRefundIfClosedNowUsdc: "0",
      nextBreak: {
        minUnits: 100,
        unitsToGo: 65,
        unitPriceUsdc: "322600000"
      },
      note: "Naira amounts are indicative. You pay the current tier price now; if the pool reaches a better tier you are refunded the difference automatically."
    }
  },
  'PoolsController.prepare': {
    request: {
      offerId: "cm3off0000example",
      fillDeadline: "2026-11-30T17:00:00.000Z",
      hub: {
        address: "12 Balogun Market, Lagos Island",
        contact: "+2348031234567"
      },
      pickupWindow: {
        from: "2026-12-05T08:00:00.000Z",
        to: "2026-12-05T16:00:00.000Z"
      },
      organizerFeeBp: 50
    },
    response: {
      txXdr: "AAAAAgAAAAD...example...AAAAAA==",
      authEntries: [
        "AAAAAQAAAAA...example...AAAA"
      ],
      validUntilLedger: 1234567,
      contract: "group_buy",
      fn: "create_pool",
      shareSlug: "a1b2c3d4e5",
      hubHash: "3b7e1d9c2a4f6e8b0d1c3e5f7a9b2d4c6e8f0a1b3d5c7e9f1a3b5d7c9e1f3a5b"
    }
  },
  'PoolsController.act': {
    request: {
      units: 5,
      method: "USDC"
    },
    response: {
      txXdr: "AAAAAgAAAAD...example...AAAAAA==",
      authEntries: [
        "AAAAAQAAAAA...example...AAAA"
      ],
      validUntilLedger: 1234567,
      contract: "group_buy",
      fn: "commit"
    }
  }
};
