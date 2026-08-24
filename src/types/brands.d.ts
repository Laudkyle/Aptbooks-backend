export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type UserId = Brand<string, 'UserId'>;
export type AccountId = Brand<string, 'AccountId'>;
export type JournalId = Brand<string, 'JournalId'>;
export type PeriodId = Brand<string, 'PeriodId'>;
export type DocumentId = Brand<string, 'DocumentId'>;
export type CurrencyCode = Brand<string, 'CurrencyCode'>;
export type LocalDate = Brand<string, 'LocalDate:YYYY-MM-DD'>;
export type IsoInstant = Brand<string, 'IsoInstant'>;
