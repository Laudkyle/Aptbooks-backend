import type { AccountId, CurrencyCode, JournalId, LocalDate, OrganizationId, PeriodId, UserId } from './brands';

export type DecimalString = `${number}`;
export type JournalStatus = 'draft' | 'submitted' | 'approved' | 'posted' | 'voided';
export type RoundingMode = 'HALF_UP';
export type PostingDatePolicy = 'DOCUMENT_DATE';
export type ReversalPolicy = 'EXPLICIT_REVERSAL';

export interface Money {
  readonly currency: CurrencyCode;
  readonly amount: DecimalString;
}

export interface PostingLine {
  readonly accountId: AccountId;
  readonly description?: string | null;
  readonly debit: DecimalString;
  readonly credit: DecimalString;
  readonly currencyCode?: CurrencyCode | null;
  readonly fxRate?: DecimalString | null;
}

export interface PostingSource {
  readonly type?: string | null;
  readonly id?: string | null;
  readonly action?: string | null;
  readonly reference?: string | null;
  readonly module?: string | null;
}

export interface PostJournalCommand {
  readonly orgId: OrganizationId;
  readonly actorUserId: UserId;
  readonly payload: {
    readonly periodId: PeriodId;
    readonly entryDate: LocalDate;
    readonly memo?: string | null;
    readonly idempotencyKey?: string | null;
    readonly lines: readonly PostingLine[];
  };
  readonly source?: PostingSource | null;
}

export interface PostingResult {
  readonly journalId: JournalId;
  readonly status: JournalStatus;
  readonly idempotent?: boolean;
  readonly accountingPolicyVersionId?: string;
  readonly accountingPolicyVersion?: number;
}

export interface AccountingPolicy {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly version: number;
  readonly effectiveFrom: LocalDate;
  readonly effectiveTo?: LocalDate | null;
  readonly moneyScale: number;
  readonly exchangeRateScale: number;
  readonly inventoryValueScale: number;
  readonly roundingMode: RoundingMode;
  readonly postingDatePolicy: PostingDatePolicy;
  readonly reversalPolicy: ReversalPolicy;
}
