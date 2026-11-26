/**
 * TEST / INTEGRATION DOUBLE ONLY.
 * Placeholder contract adapter for NEON's player contribution validation boundary.
 * Real contribution scoring/validation belongs exclusively to NEON.
 */

export interface ValidatedContributionReceipt {
  readonly contributionId: string;
  readonly playerId: string;
  readonly worldEventId: string;
  readonly isEligible: boolean;
}

export interface ContributionValidatorPort {
  verifyContribution(contributionId: string): Promise<ValidatedContributionReceipt | null>;
}

export class FakeContributionValidator implements ContributionValidatorPort {
  private readonly receipts = new Map<string, ValidatedContributionReceipt>();

  public seedReceipt(receipt: ValidatedContributionReceipt): void {
    this.receipts.set(receipt.contributionId, receipt);
  }

  public async verifyContribution(
    contributionId: string,
  ): Promise<ValidatedContributionReceipt | null> {
    return this.receipts.get(contributionId) ?? null;
  }
}
