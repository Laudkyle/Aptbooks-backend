export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: Readonly<Record<string, string[]>> | null;
    readonly details?: unknown;
  };
  readonly requestId?: string | null;
}

export interface ApiSuccess<T, M = Record<string, never>> {
  readonly data: T;
  readonly meta?: M;
  readonly requestId?: string | null;
}
