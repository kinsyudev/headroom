export type DeckErrorCode =
  | 'invalid'
  | 'unknown_account'
  | 'link_down'
  | 'cpa_unreachable'
  | 'cpa_error'
  | 'not_claimable'
  | 'unavailable';

export const DECK_ERROR_STATUS: Readonly<Record<DeckErrorCode, number>> = {
  invalid: 400,
  unknown_account: 404,
  link_down: 503,
  cpa_unreachable: 502,
  cpa_error: 502,
  not_claimable: 409,
  unavailable: 503,
};

export class DeckError extends Error {
  constructor(
    readonly code: DeckErrorCode,
    message: string,
  ) {
    super(message);
  }
}
